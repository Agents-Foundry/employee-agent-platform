/**
 * Model-quality history files (ADR 0025). Each scheduled run appends one compact record per
 * trial to a JSON Lines file that is carried from run to run. The record format and the trend
 * live in `src/quality/quality-history.ts`, shared with the control plane (ADR 0026).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { QualitySeries, QualitySeriesStatus } from '@agents-foundry/contracts';
import {
  BASELINE_RUNS,
  HISTORY_VERSION,
  historyRecordSchema,
  parseHistory,
  percent,
  sparkline,
  type HistoryRecord,
} from '../../src/quality/quality-history.js';
import type { QualityReport } from './quality.js';

export {
  BASELINE_RUNS,
  PASS_RATE_DROP,
  SCORE_DROP,
  sparkline,
  trend,
  type HistoryRecord,
} from '../../src/quality/quality-history.js';

/** The run-level facts a report file carries beside its reports. */
export interface RunMetadata {
  runId: string;
  runAt: string;
  commit: string | null;
  judgeModel: string;
}

const text = z.string().min(1).max(200);
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
    historyRecordSchema.parse({
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
  return existsSync(path) ? parseHistory(readFileSync(path, 'utf8')) : [];
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

/** A Markdown trend table, regressions first. */
export function trendMarkdown(series: readonly QualitySeries[]): string {
  if (!series.length) return '# Model-quality trend\n\nNo history yet.\n';
  const order: Record<QualitySeriesStatus, number> = {
    REGRESSED: 0,
    NEW: 1,
    IMPROVED: 2,
    STEADY: 3,
  };
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
          `| ${item.status}${item.reasons.length ? `: ${item.reasons.join('; ')}` : ''} | ${item.provider}/${item.model} (${item.judgeModel}) | ${item.blueprint} | ${item.task} | ${item.runs.length} | ${percent(item.latest.passRate)} of ${item.latest.trials} | ${item.latest.meanScore.toFixed(2)} | ${item.baseline ? `${percent(item.baseline.passRate)}, ${item.baseline.meanScore.toFixed(2)}` : '-'} | ${sparkline(item.runs)} |`,
      ),
  ];
  return `${lines.join('\n')}\n`;
}
