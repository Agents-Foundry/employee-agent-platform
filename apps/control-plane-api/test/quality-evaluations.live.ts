/**
 * Live model-quality evaluations (ADR 0020): every quality task of every role's suite, on every
 * blueprint version it applies to, worked by a real model and graded by a grader model.
 * Run with `npm run eval:quality`; it spends real tokens, so it never runs in `npm run check`.
 *
 * Settings (environment or the repository's `.env`), all read by `loadQualityConfig`:
 * AF_QUALITY_MODEL, AF_QUALITY_JUDGE_MODEL, AF_QUALITY_MAX_TOKENS (required),
 * AF_MODEL_API_KEY_<PROVIDER> (required), AF_QUALITY_PROVIDER (default anthropic),
 * AF_QUALITY_TRIALS, AF_QUALITY_JUDGE_MAX_TOKENS, AF_QUALITY_PRICE_PER_MTOK,
 * AF_QUALITY_REPORT_DIR, and the filters AF_EVALUATION_ROLE and AF_QUALITY_TASK.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { isKnownAction } from '../../../packages/policy-engine/src/index.js';
import { AnthropicProvider } from '../../agent-runtime/src/models/anthropic-provider.js';
import {
  EnvironmentCredentialBroker,
  type ModelProvider,
} from '../../agent-runtime/src/models/model-gateway.js';
import { resolveCatalog } from '../src/catalog/catalog-registry.js';
import { BudgetedProvider, TokenLedger } from './evaluations/budget.js';
import { ModelJudge } from './evaluations/judge.js';
import {
  loadQualityConfig,
  runQualityTask,
  writeQualityReports,
  type QualityReport,
} from './evaluations/quality.js';

resolveCatalog(builtInCatalog, isKnownAction);
const config = loadQualityConfig(process.env);
const providers: Record<string, () => ModelProvider> = {
  anthropic: () => new AnthropicProvider(),
};
const provider = providers[config.provider];
if (!provider) throw new Error(`QUALITY_CONFIG_INVALID: unknown provider ${config.provider}`);
const credentials = new EnvironmentCredentialBroker();
const ledger = new TokenLedger(config.maxTokens);
const reports: QualityReport[] = [];
const startedAt = new Date().toISOString();

const cases = builtInCatalog.blueprints
  .filter((blueprint) => !config.role || blueprint.id === config.role)
  .flatMap((blueprint) => {
    const suite = builtInCatalog.evaluationSuites.find(
      (item) => item.id === blueprint.evaluations.suite,
    )!;
    return (suite.qualityTasks ?? [])
      .filter((task) => !config.task || task.id === config.task)
      .filter(
        (task) => !task.blueprintVersions || task.blueprintVersions.includes(blueprint.version),
      )
      .flatMap((task) =>
        Array.from({ length: config.trials }, (_, index) => ({
          name: `${blueprint.id}@${blueprint.version} ${suite.id}/${task.id} trial ${index + 1}`,
          blueprint,
          suite,
          task,
          trial: index + 1,
        })),
      );
  });

describe('model-quality evaluations', () => {
  afterAll(() => {
    if (!reports.length) return;
    const path = writeQualityReports(config.reportDir, reports, ledger.spent, {
      runId: randomUUID(),
      runAt: startedAt,
      commit: /^[0-9a-f]{7,64}$/.test(process.env['GITHUB_SHA'] ?? '')
        ? process.env['GITHUB_SHA']!
        : null,
      judge: { provider: config.provider, model: config.judgeModel },
    });
    console.log(`Quality report: ${path} (${ledger.spent} of ${ledger.limit} tokens)`);
  });

  it('selects at least one task', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$name', async ({ blueprint, suite, task, trial }) => {
    const report = await runQualityTask(blueprint, suite, task, {
      agent: { provider: provider(), model: config.model, credentials },
      judge: new ModelJudge(
        new BudgetedProvider(
          provider(),
          { maxInputTokens: 200_000, maxOutputTokens: config.judgeMaxTokens },
          ledger,
        ),
        config.judgeModel,
        credentials,
        config.judgeMaxTokens,
      ),
      ledger,
      ...(config.pricing ? { pricing: config.pricing } : {}),
      trial,
    });
    reports.push(report);
    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
  });
});
