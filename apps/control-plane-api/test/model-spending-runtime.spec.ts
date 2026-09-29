/**
 * Model spending limits end to end (ADR 0021): the real agent runtime reserves every model call
 * with the control plane before making it, and settles the provider-reported usage after.
 */
import { describe, expect, it } from 'vitest';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { withEvaluationEnvironment } from './evaluations/world.js';

describe('model spending through the agent runtime', () => {
  const blueprint = builtInCatalog.blueprints.find(
    (item) => item.id === 'engineering.code-reviewer',
  )!;
  const suite = builtInCatalog.evaluationSuites.find(
    (item) => item.id === blueprint.evaluations.suite,
  )!;
  const scenario = suite.scenarios[0]!;
  const credentials = { resolve: async () => ({ apiKey: 'test' }) };

  const agent = (calls: { maxTokens: number }[]) =>
    new ScriptedProvider('metered-model', (req) => {
      calls.push({ maxTokens: req.maxTokens });
      return {
        content: [{ type: 'text', text: 'Reviewed.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1234, outputTokens: 56 },
      };
    });

  it('reserves before and settles after each call with the provider-reported usage', async () => {
    const calls: { maxTokens: number }[] = [];
    await withEvaluationEnvironment(
      {
        blueprint,
        suite,
        answers: scenario.answers,
        model: { provider: agent(calls), model: 'metered', credentials },
      },
      async (environment) => {
        const run = await environment.startRun(scenario.task);
        await environment.drive(run.id!, () => 'REJECTED', 2);
        expect(await environment.runStatus(run.id!)).toBe('COMPLETED');
        expect(calls).toEqual([{ maxTokens: 4096 }]);
        const [usage] = await environment.modelUsage();
        expect(usage).toMatchObject({
          status: 'SETTLED',
          provider: 'metered-model',
          model: 'metered',
          max_output_tokens: 4096,
          input_tokens: 1234,
          output_tokens: 56,
        });
        // The estimate covers the whole prompt, including every offered tool's schema.
        expect(Number(usage!['reserved_tokens']) - 4096).toBeGreaterThan(1000);
      },
    );
  }, 120_000);

  it('makes no model call once the limit is reached, and fails the run', async () => {
    const calls: { maxTokens: number }[] = [];
    await withEvaluationEnvironment(
      {
        blueprint,
        suite,
        answers: scenario.answers,
        model: { provider: agent(calls), model: 'metered', credentials },
        modelBudget: { monthlyTokenLimit: null, runTokenLimit: 1000 },
      },
      async (environment) => {
        const run = await environment.startRun(scenario.task);
        await environment.drive(run.id!, () => 'REJECTED', 2);
        expect(await environment.runOutcome(run.id!)).toEqual({
          status: 'FAILED',
          statusReason: 'MODEL_BUDGET_EXCEEDED',
        });
        expect(calls).toEqual([]);
        expect(await environment.modelUsage()).toEqual([]);
      },
    );
  }, 120_000);
});
