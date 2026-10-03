/**
 * Pilot readiness (ADR 0038). A capability's status is computed from the tests that ran for
 * the commit being assessed, never declared: a type, a table or a route proves nothing, and a
 * proof that was skipped, renamed or deleted counts as missing.
 */
export type Status = 'GREEN' | 'AMBER' | 'RED';

export interface Proof {
  /** Repository-relative path of the test file. */
  file: string;
  /** The test's title, exactly. */
  test: string;
}

export interface ProofSuite {
  file: string;
  /** A `describe` block all of whose tests must pass. */
  describe: string;
  minimumTests: number;
}

export interface Capability {
  id: string;
  title: string;
  /** The worst status the build accepts for this capability. */
  minimum: Status;
  proofs: Proof[];
  proofSuites?: ProofSuite[];
  /** Proofs that need infrastructure a build may not have (for example Docker). */
  operationalProofs?: Proof[];
  limitations?: string[];
}

export interface Limitation {
  id: string;
  /** BLOCKING stops a pilot; ACCEPTED is carried into a controlled pilot knowingly. */
  severity: 'BLOCKING' | 'ACCEPTED' | 'INFORMATIONAL';
  summary: string;
  beforePilot: string;
}

export interface Assessment {
  version: 1;
  description: string;
  capabilities: Capability[];
  limitations: Limitation[];
}

export interface TestOutcome {
  file: string;
  title: string;
  ancestors: string[];
  status: 'passed' | 'failed' | 'skipped';
}

export interface ProofResult extends Proof {
  outcome: 'passed' | 'failed' | 'skipped' | 'missing';
}

export interface CapabilityReport {
  id: string;
  title: string;
  status: Status;
  minimum: Status;
  meetsMinimum: boolean;
  reasons: string[];
  proofs: ProofResult[];
  operationalProofs: ProofResult[];
  limitations: Limitation[];
}

export interface ReadinessReport {
  generatedAt: string;
  commit: string | null;
  tests: { passed: number; failed: number; skipped: number };
  capabilities: CapabilityReport[];
  limitations: Limitation[];
  /** No capability is RED, and none is below its minimum. */
  readyForControlledPilot: boolean;
  problems: string[];
}

const RANK: Record<Status, number> = { RED: 0, AMBER: 1, GREEN: 2 };
const normalize = (path: string) => path.replace(/\\/g, '/');

/** Outcomes from a Vitest JSON report (`--reporter=json`), with paths made repository-relative. */
export function outcomesFromVitest(report: unknown, repositoryRoot: string): TestOutcome[] {
  const root = `${normalize(repositoryRoot).replace(/\/+$/, '')}/`;
  const files = (report as { testResults?: unknown[] } | null)?.testResults;
  if (!Array.isArray(files)) throw new Error('READINESS_RESULTS_INVALID');
  return files.flatMap((entry) => {
    const { name, assertionResults } = entry as {
      name?: unknown;
      assertionResults?: { title?: unknown; status?: unknown; ancestorTitles?: unknown }[];
    };
    if (typeof name !== 'string' || !Array.isArray(assertionResults))
      throw new Error('READINESS_RESULTS_INVALID');
    const path = normalize(name);
    const file = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path;
    return assertionResults.map((test): TestOutcome => ({
      file,
      title: String(test.title),
      ancestors: Array.isArray(test.ancestorTitles) ? test.ancestorTitles.map(String) : [],
      status: test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped',
    }));
  });
}

export function assess(
  assessment: Assessment,
  outcomes: readonly TestOutcome[],
  context: { commit?: string | null; now?: Date } = {},
): ReadinessReport {
  const problems: string[] = [];
  const limitations = new Map(assessment.limitations.map((item) => [item.id, item]));
  if (limitations.size !== assessment.limitations.length) problems.push('Duplicate limitation id.');
  const linked = new Set<string>();
  const resolve = (proof: Proof): ProofResult => {
    const matches = outcomes.filter(
      (outcome) => outcome.file === proof.file && outcome.title === proof.test,
    );
    // One failure among same-named tests is a failure; a proof that did not run proves nothing.
    const outcome = !matches.length
      ? 'missing'
      : matches.some((match) => match.status === 'failed')
        ? 'failed'
        : matches.every((match) => match.status === 'passed')
          ? 'passed'
          : 'skipped';
    return { ...proof, outcome };
  };

  const capabilities = assessment.capabilities.map((capability): CapabilityReport => {
    const reasons: string[] = [];
    if (!capability.proofs.length) reasons.push('No proof is named for this capability.');
    const proofs = capability.proofs.map(resolve);
    for (const proof of proofs)
      if (proof.outcome !== 'passed')
        reasons.push(`Proof ${proof.outcome}: ${proof.file} › ${proof.test}`);
    for (const suite of capability.proofSuites ?? []) {
      const tests = outcomes.filter(
        (outcome) => outcome.file === suite.file && outcome.ancestors.includes(suite.describe),
      );
      const passed = tests.filter((test) => test.status === 'passed').length;
      if (passed !== tests.length || passed < suite.minimumTests)
        reasons.push(
          `Suite not proven: ${suite.file} › ${suite.describe} (${passed} of ${tests.length} passed, ${suite.minimumTests} required)`,
        );
    }
    const open = (capability.limitations ?? []).flatMap((id) => {
      const limitation = limitations.get(id);
      if (!limitation) {
        problems.push(`${capability.id} names an unknown limitation: ${id}`);
        return [];
      }
      linked.add(id);
      return [limitation];
    });
    for (const limitation of open)
      if (limitation.severity === 'BLOCKING') reasons.push(`Blocking limitation: ${limitation.id}`);
    const red = reasons.length > 0;

    const operationalProofs = (capability.operationalProofs ?? []).map(resolve);
    const softer: string[] = [];
    for (const proof of operationalProofs) {
      // A failed operational proof is a failure. One that could not run here is not a pass.
      if (proof.outcome === 'failed' || proof.outcome === 'missing')
        reasons.push(`Operational proof ${proof.outcome}: ${proof.file} › ${proof.test}`);
      else if (proof.outcome === 'skipped')
        softer.push(`Not exercised in this environment: ${proof.file} › ${proof.test}`);
    }
    for (const limitation of open)
      if (limitation.severity === 'ACCEPTED') softer.push(`Accepted limitation: ${limitation.id}`);
    const status: Status = red || reasons.length ? 'RED' : softer.length ? 'AMBER' : 'GREEN';
    return {
      id: capability.id,
      title: capability.title,
      status,
      minimum: capability.minimum,
      meetsMinimum: RANK[status] >= RANK[capability.minimum],
      reasons: [...reasons, ...softer],
      proofs,
      operationalProofs,
      limitations: open,
    };
  });

  for (const capability of capabilities)
    if (!capability.meetsMinimum)
      problems.push(
        `${capability.id} is ${capability.status}, below its minimum ${capability.minimum}.`,
      );
  const ids = capabilities.map((capability) => capability.id);
  if (new Set(ids).size !== ids.length) problems.push('Duplicate capability id.');
  return {
    generatedAt: (context.now ?? new Date()).toISOString(),
    commit: context.commit ?? null,
    tests: {
      passed: outcomes.filter((outcome) => outcome.status === 'passed').length,
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    },
    capabilities,
    // Every outstanding limitation is reported, whether or not a capability names it.
    limitations: assessment.limitations,
    readyForControlledPilot:
      problems.length === 0 && capabilities.every((capability) => capability.status !== 'RED'),
    problems,
  };
}
