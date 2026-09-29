/**
 * Governance evaluations (ADR 0019): every scenario of every role's suite, on every blueprint
 * version it applies to, through the real control plane, agent runtime and execution runtime.
 * Filter with AF_EVALUATION_ROLE=<blueprint id>.
 */
import { describe, expect, it } from 'vitest';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { isKnownAction } from '../../../packages/policy-engine/src/index.js';
import { resolveCatalog } from '../src/catalog/catalog-registry.js';
import { runScenario } from './evaluations/runner.js';

// Fails here, with every problem listed, if a suite is inconsistent with its role.
resolveCatalog(builtInCatalog, isKnownAction);

const only = process.env['AF_EVALUATION_ROLE'];
const cases = builtInCatalog.blueprints
  .filter((blueprint) => !only || blueprint.id === only)
  .flatMap((blueprint) => {
    const suite = builtInCatalog.evaluationSuites.find(
      (item) => item.id === blueprint.evaluations.suite,
    )!;
    return suite.scenarios
      .filter(
        (scenario) =>
          !scenario.blueprintVersions || scenario.blueprintVersions.includes(blueprint.version),
      )
      .map((scenario) => ({
        name: `${blueprint.id}@${blueprint.version} ${suite.id}/${scenario.id}`,
        blueprint,
        suite,
        scenario,
      }));
  });

describe('role governance evaluations', () => {
  it('covers every role version with at least one scenario', () => {
    const covered = new Set(cases.map((item) => `${item.blueprint.id}@${item.blueprint.version}`));
    for (const blueprint of builtInCatalog.blueprints.filter((b) => !only || b.id === only))
      expect(covered, `${blueprint.id}@${blueprint.version}`).toContain(
        `${blueprint.id}@${blueprint.version}`,
      );
  });

  it.each(cases)('$name', async ({ blueprint, suite, scenario }) => {
    const report = await runScenario(blueprint, suite, scenario);
    expect(report.failures, JSON.stringify(report.results, null, 2)).toEqual([]);
    // Each scenario runs the whole stack; the parallel suite makes that slow on some machines.
  }, 120_000);
});
