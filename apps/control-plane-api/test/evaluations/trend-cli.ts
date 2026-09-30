/**
 * Model-quality trend (ADR 0025): adds a run's reports to the score history and summarizes
 * each series against the runs before it.
 *
 *   npm run eval:quality:trend -- --history <file> [--reports <dir>] [--summary <file>]
 *     [--fail-on-regression]
 *
 * `--reports` adds every `quality-*.json` in the directory; runs already in the history are
 * skipped. `--summary` appends the Markdown (for example to `$GITHUB_STEP_SUMMARY`).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendHistory,
  historyRecords,
  readHistory,
  readReportFile,
  trend,
  trendMarkdown,
} from './history.js';

export interface TrendOptions {
  history: string;
  reports?: string;
  summary?: string;
  failOnRegression: boolean;
}

export function parseArguments(argv: readonly string[]): TrendOptions {
  const options: Partial<TrendOptions> = { failOnRegression: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith('--'))
        throw new Error(`QUALITY_TREND_USAGE: ${flag} needs a value`);
      return next;
    };
    if (flag === '--history') options.history = value();
    else if (flag === '--reports') options.reports = value();
    else if (flag === '--summary') options.summary = value();
    else if (flag === '--fail-on-regression') options.failOnRegression = true;
    else throw new Error(`QUALITY_TREND_USAGE: unknown argument ${flag}`);
  }
  if (!options.history) throw new Error('QUALITY_TREND_USAGE: --history is required');
  return options as TrendOptions;
}

/** Adds the reports, then returns the trend; `failed` when a regression should fail the job. */
export function runTrend(options: TrendOptions): {
  added: number;
  markdown: string;
  regressions: number;
  failed: boolean;
} {
  let added = 0;
  if (options.reports && existsSync(options.reports))
    for (const name of readdirSync(options.reports)
      .filter((file) => /^quality-.*\.json$/.test(file))
      .sort()) {
      const { metadata, reports } = readReportFile(
        readFileSync(join(options.reports, name), 'utf8'),
      );
      added += appendHistory(options.history, historyRecords(reports, metadata));
    }
  const series = trend(readHistory(options.history));
  const markdown = trendMarkdown(series);
  if (options.summary) appendFileSync(options.summary, markdown);
  const regressions = series.filter((item) => item.status === 'REGRESSED').length;
  return { added, markdown, regressions, failed: options.failOnRegression && regressions > 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = runTrend(parseArguments(process.argv.slice(2)));
    console.log(`Added ${result.added} records to the history.\n\n${result.markdown}`);
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    // Only the code: a malformed file's content is not echoed.
    console.error((error as Error).message.split('\n')[0]);
    process.exitCode = 2;
  }
}
