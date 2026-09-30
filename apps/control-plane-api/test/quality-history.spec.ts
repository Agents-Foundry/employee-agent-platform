/**
 * Model-quality history and trend (ADR 0025): the records kept per trial, the history file,
 * regression detection per series, and the command the scheduled workflow runs. No model is
 * called: reports are built here, as a live run would write them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  historyRecords,
  readHistory,
  readReportFile,
  sparkline,
  trend,
  trendMarkdown,
  type HistoryRecord,
  type RunMetadata,
} from './evaluations/history.js';
import { writeQualityReports, type QualityReport } from './evaluations/quality.js';
import { parseArguments, runTrend } from './evaluations/trend-cli.js';

const report = (overrides: Partial<QualityReport> = {}): QualityReport => ({
  blueprint: 'engineering.qa-engineer@1.2.0',
  suite: 'qa-engineer',
  task: 'file-defect',
  trial: 1,
  model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  passed: true,
  score: 0.9,
  passThreshold: 0.7,
  failedGates: [],
  checks: [{ id: 'no-denials', kind: 'no-denials', weight: 1, required: true, passed: true }],
  criteria: [{ id: 'precise', weight: 1, score: 0.9, rationale: 'Quotes the failing step.' }],
  runStatus: 'COMPLETED',
  executedActions: ['issue.create'],
  approvals: [{ action: 'issue.create', decision: 'APPROVED' }],
  calls: [{ tool: 'issue-tracker', outcome: 'SUCCEEDED' }],
  finalMessage: 'Filed DEF-1 with the steps to reproduce.',
  usage: { inputTokens: 1200, outputTokens: 300, calls: 3 },
  budgetExceeded: null,
  estimatedCostUsd: 0.0081,
  durationMs: 42_000,
  ...overrides,
});

let clock = Date.parse('2026-06-01T06:00:00.000Z');
/** One run's records: `outcomes` are [passed, score] per trial. */
const run = (
  outcomes: [boolean, number][],
  overrides: Partial<QualityReport> = {},
  judgeModel = 'claude-opus-5-5',
): HistoryRecord[] => {
  clock += 7 * 86_400_000;
  const metadata: RunMetadata = {
    runId: `run-${clock}`,
    runAt: new Date(clock).toISOString(),
    commit: 'abc1234',
    judgeModel,
  };
  return historyRecords(
    outcomes.map(([passed, score], index) =>
      report({ passed, score, trial: index + 1, ...overrides }),
    ),
    metadata,
  );
};

describe('quality history', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'af-quality-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('keeps scores and outcomes per trial, never what the model wrote', () => {
    const [record] = run([[true, 0.9]]);
    expect(record).toMatchObject({
      v: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      judgeModel: 'claude-opus-5-5',
      blueprint: 'engineering.qa-engineer@1.2.0',
      task: 'file-defect',
      passed: true,
      score: 0.9,
      tokens: 1500,
      estimatedCostUsd: 0.0081,
      commit: 'abc1234',
    });
    expect(JSON.stringify(record)).not.toMatch(/DEF-1|failing step/);
  });

  it('appends each run once and refuses a malformed history, naming only the line', () => {
    const path = join(directory, 'nested', 'history.jsonl');
    expect(readHistory(path)).toEqual([]);
    const first = run([
      [true, 0.9],
      [true, 0.8],
    ]);
    expect(appendHistory(path, first)).toBe(2);
    expect(appendHistory(path, first)).toBe(0);
    expect(readHistory(path)).toEqual(first);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"secret":"do-not-echo"}\n`);
    expect(() => readHistory(path)).toThrow(/^QUALITY_HISTORY_INVALID: line 3$/);
  });

  it('reads report files strictly', () => {
    const path = writeQualityReports(directory, [report()], 1500, {
      runId: 'run-1',
      runAt: '2026-09-28T06:00:00.000Z',
      commit: null,
      judge: { provider: 'anthropic', model: 'claude-opus-5-5' },
    });
    const { metadata, reports } = readReportFile(readFileSync(path, 'utf8'));
    expect(metadata).toEqual({
      runId: 'run-1',
      runAt: '2026-09-28T06:00:00.000Z',
      commit: null,
      judgeModel: 'claude-opus-5-5',
    });
    expect(reports).toHaveLength(1);
    // A report from before ADR 0025 has no run metadata, and is refused.
    expect(() => readReportFile(JSON.stringify({ spentTokens: 1, reports: [] }))).toThrow();
  });
});

describe('quality trend', () => {
  it('compares the latest run with the runs before it, per series', () => {
    const steady = [
      ...run([
        [true, 0.9],
        [true, 0.85],
        [true, 0.8],
      ]),
      ...run([
        [true, 0.9],
        [true, 0.9],
        [true, 0.8],
      ]),
    ];
    // Another series in the same runs: a different task.
    const other = { task: 'triage' };
    const history = [
      ...steady,
      ...run([
        [true, 0.9],
        [false, 0.5],
        [false, 0.4],
      ]),
    ];
    let series = trend(history);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      status: 'REGRESSED',
      baseline: { runs: 2, passRate: 1 },
      latest: { trials: 3 },
    });
    expect(series[0]!.reasons).toEqual(['pass rate 100% → 33%', 'mean score 0.86 → 0.60']);

    // A small change is steady; a large gain is an improvement.
    series = trend([
      ...steady,
      ...run([
        [true, 0.84],
        [true, 0.8],
        [true, 0.8],
      ]),
    ]);
    expect(series[0]!.status).toBe('STEADY');
    const weak = run([
      [false, 0.3],
      [false, 0.4],
    ]);
    series = trend([
      ...weak,
      ...run([
        [true, 0.8],
        [true, 0.9],
      ]),
    ]);
    expect(series[0]!.status).toBe('IMPROVED');

    // The first run of a series is new, whatever its score.
    series = trend([...steady, ...run([[false, 0.1]], other)]);
    expect(series).toEqual([
      expect.objectContaining({ task: 'triage', status: 'NEW', baseline: null }),
    ]);
  });

  it('keeps a grader change in its own series, and ignores runs older than the baseline', () => {
    const old = run([
      [false, 0.1],
      [false, 0.1],
    ]);
    const recent = [...run([[true, 0.8]]), ...run([[true, 0.8]]), ...run([[true, 0.8]])];
    const latest = run([[true, 0.8]]);
    const series = trend([...old, ...recent, ...latest]);
    expect(series[0]).toMatchObject({
      status: 'STEADY',
      baseline: { runs: 3, passRate: 1, meanScore: expect.closeTo(0.8) },
    });
    expect(series[0]!.runs).toHaveLength(5);

    const regraded = trend([...recent, ...run([[true, 0.5]], {}, 'another-grader')]);
    expect(regraded).toEqual([
      expect.objectContaining({ judgeModel: 'another-grader', status: 'NEW' }),
    ]);
  });

  it('writes a Markdown table with regressions first', () => {
    expect(trendMarkdown([])).toContain('No history yet.');
    const history = [...run([[true, 0.9]]), ...run([[true, 0.9]], { task: 'triage' })];
    const lastRun = history.at(-1)!.runId;
    // Both series in the latest run: the first task regresses, the second is new.
    const latest = [
      ...historyRecords([report({ passed: false, score: 0.2 })], {
        runId: 'run-final',
        runAt: '2027-01-01T06:00:00.000Z',
        commit: null,
        judgeModel: 'claude-opus-5-5',
      }),
      ...historyRecords([report({ task: 'triage', score: 0.9 })], {
        runId: 'run-final',
        runAt: '2027-01-01T06:00:00.000Z',
        commit: null,
        judgeModel: 'claude-opus-5-5',
      }),
    ];
    expect(lastRun).not.toBe('run-final');
    const markdown = trendMarkdown(trend([...history, ...latest]));
    expect(markdown).toContain('**1 series regressed**');
    const rows = markdown
      .split('\n')
      .filter((line) => line.startsWith('| REGRESSED') || line.startsWith('| STEADY'));
    expect(rows[0]).toMatch(/^\| REGRESSED: pass rate 100% → 0%; mean score 0.90 → 0.20 \|/);
    expect(
      sparkline(
        [0, 0.2, 0.5, 0.99, 1].map((meanScore) => ({
          runId: '',
          runAt: '',
          trials: 1,
          passRate: 1,
          meanScore,
        })),
      ),
    ).toBe('▁▂▅██');
  });
});

describe('quality trend command', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'af-quality-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const write = (runId: string, runAt: string, reports: QualityReport[]) =>
    writeQualityReports(join(directory, runId), reports, 1500, {
      runId,
      runAt,
      commit: null,
      judge: { provider: 'anthropic', model: 'claude-opus-5-5' },
    });

  it('records a run, skips it the second time, and fails on a regression when asked', () => {
    const history = join(directory, 'history', 'quality-history.jsonl');
    const summary = join(directory, 'summary.md');
    write('run-a', '2026-09-07T06:00:00.000Z', [report(), report({ trial: 2 })]);
    let result = runTrend({
      history,
      reports: join(directory, 'run-a'),
      summary,
      failOnRegression: true,
    });
    expect(result).toMatchObject({ added: 2, regressions: 0, failed: false });
    expect(
      runTrend({ history, reports: join(directory, 'run-a'), failOnRegression: true }).added,
    ).toBe(0);

    write('run-b', '2026-09-14T06:00:00.000Z', [
      report({ passed: false, score: 0.3 }),
      report({ passed: false, score: 0.3, trial: 2 }),
    ]);
    result = runTrend({
      history,
      reports: join(directory, 'run-b'),
      summary,
      failOnRegression: false,
    });
    expect(result).toMatchObject({ added: 2, regressions: 1, failed: false });
    expect(runTrend({ history, failOnRegression: true }).failed).toBe(true);
    expect(readHistory(history)).toHaveLength(4);
    expect(readFileSync(summary, 'utf8')).toContain('**1 series regressed**');
  });

  it('parses its arguments strictly', () => {
    expect(parseArguments(['--history', 'h.jsonl', '--fail-on-regression'])).toEqual({
      history: 'h.jsonl',
      failOnRegression: true,
    });
    expect(() => parseArguments([])).toThrow('--history is required');
    expect(() => parseArguments(['--history'])).toThrow('--history needs a value');
    expect(() => parseArguments(['--history', 'h', '--push'])).toThrow('unknown argument --push');
  });
});
