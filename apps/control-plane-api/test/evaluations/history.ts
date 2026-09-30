/**
 * Model-quality history (ADR 0025). Each scheduled run appends one compact record per trial to
 * a JSON Lines file that is carried from run to run. Scores are then followed per series (the
 * model, its grader, the role version and the task), and the latest run is compared with the
 * runs before it. Model output is not kept: only scores, outcomes and usage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { QualityReport } from './quality.js';

export const HISTORY_VERSION = 1;
/** How many earlier runs of a series the latest run is compared with. */
export const BASELINE_RUNS = 3;
/** A drop in pass rate at least this large is a regression. */
export const PASS_RATE_DROP = 0.34;
/** A drop in mean score at least this large is a regression. */
export const SCORE_DROP = 0.1;

const text = z.string().min(1).max(200);
const recordSchema = z
  .object({
    v: z.literal(HISTORY_VERSION),
    runId: text,
    runAt: z.iso.datetime(),
    commit: z.string().max(64).nullable(),
    provider: text,
    model: text,
    judgeModel: text,
    blueprint: text,
    suite: text,
    task: text,
    trial: z.number().int().min(1).max(100),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    passThreshold: z.number().min(0).max(1),
    failedGates: z.array(text).max(50),
    runStatus: text,
    tokens: z.number().int().min(0),
    estimatedCostUsd: z.number().min(0).nullable(),
  })
  .strict();
export type HistoryRecord = z.infer<typeof recordSchema>;

/** The run-level facts a report file carries beside its reports. */
export interface RunMetadata {
  runId: string;
  runAt: string;
  commit: string | null;
  judgeModel: string;
}

const reportFileSchema = z.object({
  runId: text,
  runAt: z.iso.datetime(),
  commit: z.string().max(64).nullable(),
  judge: z.object({ provider: text, model: text }),
  spentTokens: z.number().int().min(0),
  reports: z.array(z.unknown()),
});

/** Reads a report file written by `writeQualityReports`, strictly. */
export function readReportFile(json: string): {
  metadata: RunMetadata;
  reports: QualityReport[];
} {
  const file = reportFileSchema.parse(JSON.parse(json));
  return {
    metadata: {
      runId: file.runId,
      runAt: file.runAt,
      commit: file.commit,
      judgeModel: file.judge.model,
    },
    reports: file.reports as QualityReport[],
  };
}

/** One record per trial; nothing the model wrote is kept. */
export function historyRecords(
  reports: readonly QualityReport[],
  metadata: RunMetadata,
): HistoryRecord[] {
  return reports.map((report) =>
    recordSchema.parse({
      v: HISTORY_VERSION,
      ...metadata,
      provider: report.model.provider,
      model: report.model.model,
      blueprint: report.blueprint,
      suite: report.suite,
      task: report.task,
      trial: report.trial,
      passed: report.passed,
      score: report.score,
      passThreshold: report.passThreshold,
      failedGates: report.failedGates,
      runStatus: report.runStatus,
      tokens: report.usage.inputTokens + report.usage.outputTokens,
      estimatedCostUsd: report.estimatedCostUsd,
    }),
  );
}

/**
 * Reads a history file. A missing file is an empty history; a malformed line fails the read,
 * naming its line number, rather than being skipped.
 */
export function readHistory(path: string): HistoryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line)
    .map(({ line, number }) => {
      try {
        return recordSchema.parse(JSON.parse(line));
      } catch {
        throw new Error(`QUALITY_HISTORY_INVALID: line ${number}`);
      }
    });
}

/** Appends a run's records, unless that run is already in the history. */
export function appendHistory(path: string, records: readonly HistoryRecord[]): number {
  const known = new Set(readHistory(path).map((record) => record.runId));
  const fresh = records.filter((record) => !known.has(record.runId));
  if (!fresh.length) return 0;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, fresh.map((record) => `${JSON.stringify(record)}\n`).join(''));
  return fresh.length;
}

export interface RunPoint {
  runId: string;
  runAt: string;
  trials: number;
  passRate: number;
  meanScore: number;
}

export type SeriesStatus = 'NEW' | 'STEADY' | 'IMPROVED' | 'REGRESSED';

export interface Series {
  provider: string;
  model: string;
  judgeModel: string;
  blueprint: string;
  task: string;
  /** Oldest first. */
  runs: RunPoint[];
  latest: RunPoint;
  /** The earlier runs' trials pooled, or null when this is the series' first run. */
  baseline: { runs: number; passRate: number; meanScore: number } | null;
  status: SeriesStatus;
  reasons: string[];
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Each series' runs, and how its latest run compares with up to `BASELINE_RUNS` runs before
 * it. Only series present in the latest run of the whole history are judged, so a role or
 * model that was dropped from the schedule does not keep reporting.
 */
export function trend(records: readonly HistoryRecord[]): Series[] {
  if (!records.length) return [];
  const latestRun = [...records].sort((a, b) => a.runAt.localeCompare(b.runAt)).at(-1)!.runId;
  const groups = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const key = [
      record.provider,
      record.model,
      record.judgeModel,
      record.blueprint,
      record.task,
    ].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const series: Series[] = [];
  for (const group of groups.values()) {
    const byRun = new Map<string, HistoryRecord[]>();
    for (const record of group)
      byRun.set(record.runId, [...(byRun.get(record.runId) ?? []), record]);
    const runs = [...byRun.values()]
      .map((trials) => ({
        runId: trials[0]!.runId,
        runAt: trials[0]!.runAt,
        trials: trials.length,
        passRate: trials.filter((trial) => trial.passed).length / trials.length,
        meanScore: mean(trials.map((trial) => trial.score)),
      }))
      .sort((a, b) => a.runAt.localeCompare(b.runAt));
    const latest = runs.at(-1)!;
    if (latest.runId !== latestRun) continue;
    const earlier = runs.slice(0, -1).slice(-BASELINE_RUNS);
    const pooled = earlier.flatMap((run) => byRun.get(run.runId)!);
    const baseline = pooled.length
      ? {
          runs: earlier.length,
          passRate: pooled.filter((trial) => trial.passed).length / pooled.length,
          meanScore: mean(pooled.map((trial) => trial.score)),
        }
      : null;
    const reasons: string[] = [];
    let status: SeriesStatus = 'NEW';
    if (baseline) {
      const passDrop = baseline.passRate - latest.passRate;
      const scoreDrop = baseline.meanScore - latest.meanScore;
      if (passDrop >= PASS_RATE_DROP - 1e-9)
        reasons.push(`pass rate ${pct(baseline.passRate)} → ${pct(latest.passRate)}`);
      if (scoreDrop >= SCORE_DROP - 1e-9)
        reasons.push(
          `mean score ${baseline.meanScore.toFixed(2)} → ${latest.meanScore.toFixed(2)}`,
        );
      status = reasons.length
        ? 'REGRESSED'
        : -passDrop >= PASS_RATE_DROP - 1e-9 || -scoreDrop >= SCORE_DROP - 1e-9
          ? 'IMPROVED'
          : 'STEADY';
    }
    const first = group[0]!;
    series.push({
      provider: first.provider,
      model: first.model,
      judgeModel: first.judgeModel,
      blueprint: first.blueprint,
      task: first.task,
      runs,
      latest,
      baseline,
      status,
      reasons,
    });
  }
  return series.sort((a, b) =>
    `${a.provider}/${a.model} ${a.blueprint} ${a.task}`.localeCompare(
      `${b.provider}/${b.model} ${b.blueprint} ${b.task}`,
    ),
  );
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const bars = '▁▂▃▄▅▆▇█';
/** The last eight mean scores as a one-line chart, oldest first. */
export const sparkline = (runs: readonly RunPoint[]) =>
  runs
    .slice(-8)
    .map((run) => bars[Math.min(bars.length - 1, Math.floor(run.meanScore * bars.length))])
    .join('');

/** A Markdown trend table, regressions first. */
export function trendMarkdown(series: readonly Series[]): string {
  if (!series.length) return '# Model-quality trend\n\nNo history yet.\n';
  const order: Record<SeriesStatus, number> = { REGRESSED: 0, NEW: 1, IMPROVED: 2, STEADY: 3 };
  const regressions = series.filter((item) => item.status === 'REGRESSED').length;
  const lines = [
    '# Model-quality trend',
    '',
    regressions
      ? `**${regressions} series regressed** against the ${BASELINE_RUNS} runs before.`
      : `No regressions against the ${BASELINE_RUNS} runs before.`,
    '',
    '| Status | Model (grader) | Role version | Task | Runs | Latest pass rate | Latest score | Baseline | Scores |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...series]
      .sort((a, b) => order[a.status] - order[b.status])
      .map(
        (item) =>
          `| ${item.status}${item.reasons.length ? `: ${item.reasons.join('; ')}` : ''} | ${item.provider}/${item.model} (${item.judgeModel}) | ${item.blueprint} | ${item.task} | ${item.runs.length} | ${pct(item.latest.passRate)} of ${item.latest.trials} | ${item.latest.meanScore.toFixed(2)} | ${item.baseline ? `${pct(item.baseline.passRate)}, ${item.baseline.meanScore.toFixed(2)}` : '-'} | ${sparkline(item.runs)} |`,
      ),
  ];
  return `${lines.join('\n')}\n`;
}
