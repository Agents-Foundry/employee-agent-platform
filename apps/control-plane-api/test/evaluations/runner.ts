/**
 * Generic governance evaluation runner (ADR 0019). It knows no role: everything comes from the
 * blueprint and its evaluation suite. A scripted model replays the scenario's tool calls
 * through the real control plane, agent runtime and execution runtime; the simulated world
 * (issue tracker, source control, repository checkout) comes from the suite.
 *
 * Commands, installs and browser runs are recorded, not executed: the execution runtime's own
 * tests run those operations for real. What is evaluated is governance and role wiring.
 */
import type {
  AgentBlueprintVersionDefinition,
  EvaluationScenario,
  EvaluationSuiteDefinition,
} from '@agents-foundry/contracts';
import type {
  ModelRequest,
  ModelResponse,
} from '../../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../../agent-runtime/src/models/scripted-provider.js';
import { withEvaluationEnvironment } from './world.js';

export interface ScenarioReport {
  /** Every mismatch between the scenario's expectations and what happened. */
  failures: string[];
  results: { tool: string; content: string; isError: boolean }[];
}

const toolResults = (req: ModelRequest) =>
  req.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
  );

/** Runs one scenario against one blueprint version and reports every expectation it misses. */
export async function runScenario(
  blueprint: AgentBlueprintVersionDefinition,
  suite: EvaluationSuiteDefinition,
  scenario: EvaluationScenario,
): Promise<ScenarioReport> {
  const failures: string[] = [];
  const requests: ModelRequest[] = [];
  const model = new ScriptedProvider('evaluation-model', (req): ModelResponse => {
    requests.push(req);
    const next = scenario.steps[toolResults(req).length];
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (next)
      return {
        content: [
          {
            type: 'tool_use',
            id: `toolu_${toolResults(req).length}`,
            name: next.tool,
            input: next.input,
          },
        ],
        stopReason: 'tool_use',
        usage,
      };
    return {
      content: [{ type: 'text', text: `Finished: ${scenario.task.objective}.` }],
      stopReason: 'end_turn',
      usage,
    };
  });
  return withEvaluationEnvironment(
    {
      blueprint,
      suite,
      answers: scenario.answers,
      model: {
        provider: model,
        model: 'scripted',
        credentials: { resolve: async () => ({ apiKey: 'evaluation-only' }) },
      },
    },
    async (environment) => {
      const run = await environment.startRun(scenario.task);
      if (!run.id) return { failures: [`run was not started: ${run.error}`], results: [] };

      // Drive the run; answer each approval as the scenario says.
      const paused = new Set<number>();
      await environment.drive(
        run.id,
        (approval) => {
          const index = requests.length ? toolResults(requests.at(-1)!).length : 0;
          paused.add(index);
          const step = scenario.steps[index];
          const expected = step?.expect.approval;
          if (!expected)
            failures.push(
              `step ${index + 1} (${step?.tool}) paused for ${approval.action} unexpectedly`,
            );
          else if (expected.action !== approval.action)
            failures.push(
              `step ${index + 1} (${step!.tool}) paused for ${approval.action}, expected ${expected.action}`,
            );
          return expected?.decision ?? 'REJECTED';
        },
        scenario.steps.length + 2,
      );

      // Tool results, step by step.
      const results = requests.length ? toolResults(requests.at(-1)!) : [];
      const rejectedAt = scenario.steps.findIndex(
        (step) => step.expect.approval?.decision === 'REJECTED',
      );
      const expectedResults = rejectedAt >= 0 ? rejectedAt : scenario.steps.length;
      if (results.length !== expectedResults)
        failures.push(`${results.length} tool results, expected ${expectedResults}`);
      scenario.steps.slice(0, expectedResults).forEach((step, index) => {
        const result = results[index];
        if (!result) return;
        const at = `step ${index + 1} (${step.tool})`;
        const outcome = !result.isError
          ? 'SUCCEEDED'
          : /^Tool .+ is not available\.$/.test(result.content)
            ? 'NOT_AVAILABLE'
            : 'FAILED';
        if (outcome !== step.expect.outcome)
          failures.push(`${at}: ${outcome}, expected ${step.expect.outcome}: ${result.content}`);
        const code = outcome === 'FAILED' ? result.content.split(':')[0] : undefined;
        if (step.expect.code && code !== step.expect.code)
          failures.push(`${at}: code ${code}, expected ${step.expect.code}`);
        if (step.expect.contains && !result.content.includes(step.expect.contains))
          failures.push(`${at}: result lacks "${step.expect.contains}": ${result.content}`);
        if (step.expect.approval && !paused.has(index))
          failures.push(`${at}: expected an approval for ${step.expect.approval.action}`);
      });
      if (rejectedAt >= 0 && !paused.has(rejectedAt))
        failures.push(`step ${rejectedAt + 1}: expected an approval to reject`);

      // The role as the model saw it, the run's outcome and what reached external systems.
      const first = requests[0];
      const offered = (first?.tools.map((tool) => tool.name) ?? []).sort();
      if (JSON.stringify(offered) !== JSON.stringify(scenario.expect.offeredTools))
        failures.push(
          `offered tools ${offered.join(',')}, expected ${scenario.expect.offeredTools.join(',')}`,
        );
      if (first && !first.system.includes(`Follow workflow ${scenario.task.workflow}@`))
        failures.push(`the prompt does not pin workflow ${scenario.task.workflow}`);
      const status = await environment.runStatus(run.id);
      if (status !== scenario.expect.runStatus)
        failures.push(`run ${status}, expected ${scenario.expect.runStatus}`);
      const executed = await environment.executedActions();
      if (JSON.stringify(executed) !== JSON.stringify(scenario.expect.executedActions))
        failures.push(
          `executed actions ${executed.join(',') || 'none'}, expected ${scenario.expect.executedActions.join(',') || 'none'}`,
        );
      return {
        failures,
        results: results.map((result, index) => ({
          tool: scenario.steps[index]?.tool ?? '?',
          content: result.content,
          isError: result.isError,
        })),
      };
    },
  );
}
