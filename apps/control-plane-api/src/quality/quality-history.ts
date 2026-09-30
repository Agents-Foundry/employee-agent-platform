/**
 * Model-quality history (ADRs 0025 and 0026): the record kept per trial of a scheduled live
 * evaluation, and how scores are followed per series (a model, its grader, a role version and
 * a task). Shared by the trend command and the control plane. Model output is never part of
 * a record: only scores, outcomes and usage.
 */
import { z } from 'zod';
import type {
  QualityRunPoint,
  QualitySeries,
  QualitySeriesStatus,
} from '@agents-foundry/contracts';

export const HISTORY_VERSION = 1;
/** How many earlier runs of a series the latest run is compared with. */
export const BASELINE_RUNS = 3;
/** A drop in pass rate at least this large is a regression. */
export const PASS_RATE_DROP = 0.34;
/** A drop in mean score at least this large is a regression. */
export const SCORE_DROP = 0.1;

const text = z.string().min(1).max(200);
export const historyRecordSchema = z
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
export type HistoryRecord = z.infer<typeof historyRecordSchema>;

/**
 * Parses a JSON Lines history. A malformed line fails the whole parse, naming only its line
 * number: its content is never echoed.
 */
export function parseHistory(content: string): HistoryRecord[] {
  return content
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line)
    .map(({ line, number }) => {
      try {
        return historyRecordSchema.parse(JSON.parse(line));
      } catch {
        throw new Error(`QUALITY_HISTORY_INVALID: line ${number}`);
      }
    });
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
export const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Each series' runs, and how its latest run compares with up to `BASELINE_RUNS` runs before
 * it. With `currentOnly`, only series in the history's latest run are returned, so a model or
 * role dropped from the schedule stops being judged.
 */
export function trend(
  records: readonly HistoryRecord[],
  options: { currentOnly: boolean } = { currentOnly: true },
): QualitySeries[] {
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
  const series: QualitySeries[] = [];
  for (const group of groups.values()) {
    const byRun = new Map<string, HistoryRecord[]>();
    for (const record of group)
      byRun.set(record.runId, [...(byRun.get(record.runId) ?? []), record]);
    const runs: QualityRunPoint[] = [...byRun.values()]
      .map((trials) => ({
        runId: trials[0]!.runId,
        runAt: trials[0]!.runAt,
        trials: trials.length,
        passRate: trials.filter((trial) => trial.passed).length / trials.length,
        meanScore: mean(trials.map((trial) => trial.score)),
      }))
      .sort((a, b) => a.runAt.localeCompare(b.runAt));
    const latest = runs.at(-1)!;
    if (options.currentOnly && latest.runId !== latestRun) continue;
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
    let status: QualitySeriesStatus = 'NEW';
    if (baseline) {
      const passDrop = baseline.passRate - latest.passRate;
      const scoreDrop = baseline.meanScore - latest.meanScore;
      if (passDrop >= PASS_RATE_DROP - 1e-9)
        reasons.push(`pass rate ${percent(baseline.passRate)} → ${percent(latest.passRate)}`);
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

const bars = '▁▂▃▄▅▆▇█';
/** The last eight mean scores as a one-line chart, oldest first. */
export const sparkline = (runs: readonly QualityRunPoint[]) =>
  runs
    .slice(-8)
    .map((run) => bars[Math.min(bars.length - 1, Math.floor(run.meanScore * bars.length))])
    .join('');
