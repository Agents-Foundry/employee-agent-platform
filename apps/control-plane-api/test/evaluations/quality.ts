/**
 * Model-quality evaluation runner (ADR 0020). A real model works a catalog quality task
 * unscripted, through the real control plane, agent runtime and execution runtime, against the
 * suite's simulated world and within the task's budget. The run is then graded: deterministic
 * checks on what happened, and a rubric scored by a grader model. It knows no role.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentBlueprintVersionDefinition,
  EvaluationSuiteDefinition,
  QualityTask,
} from '@agents-foundry/contracts';
import type {
  CredentialBroker,
  ModelProvider,
} from '../../../agent-runtime/src/models/model-gateway.js';
import {
  BudgetedProvider,
  estimateCost,
  type Pricing,
  type TokenLedger,
  type TokenUsage,
} from './budget.js';
import {
  finalMessage,
  gradeChecks,
  overall,
  toolCalls,
  ungraded,
  type CheckResult,
  type CriterionResult,
} from './grading.js';
import type { Judge } from './judge.js';
import { withEvaluationEnvironment } from './world.js';

export interface QualityReport {
  blueprint: string;
  suite: string;
  task: string;
  trial: number;
  model: { provider: string; model: string };
  passed: boolean;
  score: number;
  passThreshold: number;
  failedGates: string[];
  checks: CheckResult[];
  criteria: CriterionResult[];
  runStatus: string;
  executedActions: string[];
  approvals: { action: string; decision: 'APPROVED' | 'REJECTED' }[];
  /** Tool calls in order: the tool and whether its result was an error, with the error code. */
  calls: { tool: string; outcome: 'SUCCEEDED' | 'ERROR' | 'NO_RESULT'; code?: string }[];
  finalMessage: string;
  usage: TokenUsage;
  budgetExceeded: string | null;
  estimatedCostUsd: number | null;
  durationMs: number;
}

export interface QualityRunOptions {
  agent: { provider: ModelProvider; model: string; credentials: CredentialBroker };
  judge: Judge;
  ledger: TokenLedger;
  pricing?: Pricing;
  trial?: number;
}

/** Runs one quality task on one blueprint version and grades it. */
export async function runQualityTask(
  blueprint: AgentBlueprintVersionDefinition,
  suite: EvaluationSuiteDefinition,
  task: QualityTask,
  options: QualityRunOptions,
): Promise<QualityReport> {
  const started = Date.now();
  const model = new BudgetedProvider(options.agent.provider, task.budget, options.ledger);
  const approvals: QualityReport['approvals'] = [];
  return withEvaluationEnvironment(
    {
      blueprint,
      suite,
      answers: task.answers,
      model: {
        provider: model,
        model: options.agent.model,
        credentials: options.agent.credentials,
      },
      kernel: { maxTurns: task.budget.maxTurns },
      ...(task.executionResults ? { executionResults: task.executionResults } : {}),
    },
    async (environment) => {
      const run = await environment.startRun(task.task);
      let runStatus = `NOT_STARTED: ${run.error ?? 'unknown'}`;
      if (run.id) {
        // Approvals the task allows are granted; anything else is rejected, which cancels.
        await environment.drive(
          run.id,
          (approval) => {
            const decision = task.approve.includes(approval.action) ? 'APPROVED' : 'REJECTED';
            approvals.push({ action: approval.action, decision });
            return decision;
          },
          task.budget.maxTurns * 2,
        );
        runStatus = await environment.runStatus(run.id);
      }
      const calls = toolCalls(model.transcript);
      const facts = { calls, runStatus, executedActions: await environment.executedActions() };
      const checks = gradeChecks(task.checks, facts);
      const workItem = suite.world.issues.find((issue) => issue.key === task.task.workItemKey);
      const final = finalMessage(model.transcript);
      const criteria = run.id
        ? await options.judge.grade({
            objective: task.task.objective,
            ...(workItem ? { workItem } : {}),
            calls,
            finalMessage: final,
            runStatus,
            rubric: task.rubric,
          })
        : ungraded(task.rubric, 'RUN_NOT_STARTED');
      const result = overall(checks, criteria, task.passThreshold);
      return {
        blueprint: `${blueprint.id}@${blueprint.version}`,
        suite: suite.id,
        task: task.id,
        trial: options.trial ?? 1,
        model: { provider: model.id, model: options.agent.model },
        ...result,
        passThreshold: task.passThreshold,
        checks,
        criteria,
        runStatus,
        executedActions: facts.executedActions,
        approvals,
        calls: calls.map((call) => ({
          tool: call.tool,
          outcome: call.result === null ? 'NO_RESULT' : call.isError ? 'ERROR' : 'SUCCEEDED',
          ...(call.isError && call.result
            ? { code: /^([A-Z][A-Z0-9_]+):/.exec(call.result)?.[1] ?? 'TOOL_ERROR' }
            : {}),
        })),
        finalMessage: final.slice(0, 4000),
        usage: { ...model.usage },
        budgetExceeded: model.exceeded,
        estimatedCostUsd: estimateCost(model.usage, options.pricing),
        durationMs: Date.now() - started,
      };
    },
  );
}

/** Operator settings for a live quality run. Values are read, never echoed. */
export interface QualityConfig {
  provider: string;
  model: string;
  judgeModel: string;
  maxTokens: number;
  judgeMaxTokens: number;
  trials: number;
  pricing?: Pricing;
  reportDir: string;
  role?: string;
  task?: string;
}

/**
 * Reads `AF_QUALITY_*` settings. Fails closed: a missing budget, model or credential stops the
 * run before any model call, naming the missing settings but never their values.
 */
export function loadQualityConfig(env: NodeJS.ProcessEnv): QualityConfig {
  const problems: string[] = [];
  const provider = env['AF_QUALITY_PROVIDER'] ?? 'anthropic';
  const model = env['AF_QUALITY_MODEL'];
  const judgeModel = env['AF_QUALITY_JUDGE_MODEL'];
  if (!model) problems.push('AF_QUALITY_MODEL is required');
  if (!judgeModel) problems.push('AF_QUALITY_JUDGE_MODEL is required');
  const credential = `AF_MODEL_API_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  if (!env[credential]) problems.push(`${credential} is required`);
  const integer = (name: string, fallback: number | undefined, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined && fallback !== undefined) return fallback;
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return min;
    }
    return value;
  };
  // The run's total token budget has no default: spending must be an explicit decision.
  const maxTokens = integer('AF_QUALITY_MAX_TOKENS', undefined, 1000, 100_000_000);
  const judgeMaxTokens = integer('AF_QUALITY_JUDGE_MAX_TOKENS', 4000, 500, 32_000);
  const trials = integer('AF_QUALITY_TRIALS', 1, 1, 10);
  let pricing: Pricing | undefined;
  const price = env['AF_QUALITY_PRICE_PER_MTOK'];
  if (price !== undefined) {
    const [input, output] = price.split(',').map(Number);
    if (
      price.split(',').length !== 2 ||
      !Number.isFinite(input) ||
      !Number.isFinite(output) ||
      input! < 0 ||
      output! < 0
    )
      problems.push('AF_QUALITY_PRICE_PER_MTOK must be "<input>,<output>" US dollars per million');
    else pricing = { inputPerMillion: input!, outputPerMillion: output! };
  }
  if (problems.length) throw new Error(`QUALITY_CONFIG_INVALID: ${problems.join('; ')}`);
  return {
    provider,
    model: model!,
    judgeModel: judgeModel!,
    maxTokens,
    judgeMaxTokens,
    trials,
    ...(pricing ? { pricing } : {}),
    reportDir: env['AF_QUALITY_REPORT_DIR'] ?? join('..', '..', '.data', 'quality-reports'),
    ...(env['AF_EVALUATION_ROLE'] ? { role: env['AF_EVALUATION_ROLE'] } : {}),
    ...(env['AF_QUALITY_TASK'] ? { task: env['AF_QUALITY_TASK'] } : {}),
  };
}

/** A readable summary of a quality run. */
export function summarize(reports: readonly QualityReport[], spentTokens: number): string {
  const cost = reports.every((report) => report.estimatedCostUsd !== null)
    ? reports.reduce((sum, report) => sum + report.estimatedCostUsd!, 0)
    : null;
  const lines = [
    '# Model-quality evaluation',
    '',
    `Tasks: ${reports.length}. Passed: ${reports.filter((report) => report.passed).length}.`,
    `Tokens (agent and grader): ${spentTokens}.${cost === null ? '' : ` Estimated agent cost: $${cost.toFixed(4)}.`}`,
    '',
    '| Role version | Task | Trial | Score | Passed | Gates failed | Run | Tokens |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...reports.map(
      (report) =>
        `| ${report.blueprint} | ${report.task} | ${report.trial} | ${report.score.toFixed(2)} / ${report.passThreshold} | ${report.passed ? 'yes' : 'no'} | ${report.failedGates.join(', ') || '-'} | ${report.runStatus}${report.budgetExceeded ? ` (${report.budgetExceeded} spent)` : ''} | ${report.usage.inputTokens + report.usage.outputTokens} |`,
    ),
  ];
  for (const report of reports) {
    lines.push('', `## ${report.blueprint} ${report.task} (trial ${report.trial})`, '');
    for (const check of report.checks)
      lines.push(
        `- ${check.passed ? 'pass' : 'FAIL'} check ${check.id}${check.required ? ' (gate)' : ''}`,
      );
    for (const criterion of report.criteria)
      lines.push(`- ${criterion.score.toFixed(2)} ${criterion.id}: ${criterion.rationale}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the JSON and Markdown reports; returns the JSON path. */
export function writeQualityReports(
  directory: string,
  reports: readonly QualityReport[],
  spentTokens: number,
): string {
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `quality-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify({ spentTokens, reports }, null, 2)}\n`);
  writeFileSync(join(directory, `quality-${stamp}.md`), summarize(reports, spentTokens));
  return path;
}
