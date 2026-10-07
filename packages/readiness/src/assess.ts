/**
 * Pilot readiness (ADR 0038, ADR 0039). A capability's status is computed from the tests that
 * ran for the commit being assessed and from what was proven against the deployed pilot,
 * never declared: a type, a table, a route or a configuration value proves nothing, and a
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
  /**
   * Live proofs (ADR 0039): checks only a run against the deployed pilot can make, recorded by
   * `pilot:validate` or `pilot:smoke`. A build never establishes one.
   */
  liveProofs?: string[];
  limitations?: string[];
}

export interface Limitation {
  id: string;
  /** BLOCKING stops a pilot; ACCEPTED is carried into a controlled pilot knowingly. */
  severity: 'BLOCKING' | 'ACCEPTED' | 'INFORMATIONAL';
  summary: string;
  beforePilot: string;
  /** The live proof whose success shows the limitation no longer applies to the pilot. */
  resolvedBy?: string;
}

/** A proof only the deployed environment can give, and the command that gives it. */
export interface LiveProofDefinition {
  id: string;
  title: string;
  producedBy: 'pilot:validate' | 'pilot:smoke';
}

export interface Assessment {
  version: 1;
  description: string;
  capabilities: Capability[];
  limitations: Limitation[];
  liveProofs?: LiveProofDefinition[];
}

/** What `pilot:validate` or `pilot:smoke` recorded. */
export interface OperationalRecord {
  kind: 'pilot-validate' | 'pilot-smoke';
  generatedAt: string;
  commit: string | null;
  environment: string;
  proofs: Record<string, 'passed' | 'failed' | 'not-run'>;
}

export interface LiveProofResult extends LiveProofDefinition {
  status: 'passed' | 'failed' | 'not-run';
  reason: string;
  evidence: { kind: string; generatedAt: string; environment: string } | null;
}

/** An operational record older than this proves nothing about today's environment. */
export const LIVE_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  liveProofs: LiveProofResult[];
  limitations: Limitation[];
}

export interface ReadinessReport {
  generatedAt: string;
  commit: string | null;
  tests: { passed: number; failed: number; skipped: number };
  capabilities: CapabilityReport[];
  limitations: Limitation[];
  liveProofs: LiveProofResult[];
  /** Nothing the tests prove failed, and no capability is below its minimum. */
  codeProofsPassed: boolean;
  /** Every live proof ran against the pilot, for this commit, within a week, and passed. */
  operationalProofsPassed: boolean;
  /** Both, and no capability is RED. Nothing else makes a pilot ready. */
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

/** An operational record from parsed JSON; anything malformed is ignored, never trusted. */
export function operationalRecord(raw: unknown): OperationalRecord | null {
  const value = raw as Partial<OperationalRecord> | null;
  if (!value || (value.kind !== 'pilot-validate' && value.kind !== 'pilot-smoke')) return null;
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt)))
    return null;
  if (!value.proofs || typeof value.proofs !== 'object') return null;
  const proofs: OperationalRecord['proofs'] = {};
  for (const [id, status] of Object.entries(value.proofs))
    if (status === 'passed' || status === 'failed' || status === 'not-run') proofs[id] = status;
  return {
    kind: value.kind,
    generatedAt: value.generatedAt,
    commit: typeof value.commit === 'string' ? value.commit : null,
    environment: typeof value.environment === 'string' ? value.environment : 'unknown',
    proofs,
  };
}

/**
 * Each live proof from the newest operational record that ran it. A record counts only if it
 * names the commit being assessed and is at most a week old: a proof of another release, or of
 * last month's environment, says nothing about this one.
 */
export function liveProofResults(
  definitions: readonly LiveProofDefinition[],
  records: readonly OperationalRecord[],
  commit: string | null,
  now: Date,
): LiveProofResult[] {
  const ordered = [...records].sort(
    (a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
  );
  return definitions.map((definition): LiveProofResult => {
    const ran = ordered.filter((record) => {
      const status = record.proofs[definition.id];
      return status === 'passed' || status === 'failed';
    });
    if (!ran.length)
      return {
        ...definition,
        status: 'not-run',
        reason: `run ${definition.producedBy} against the pilot`,
        evidence: null,
      };
    const newest = ran.find(
      (record) =>
        !!commit &&
        record.commit === commit &&
        now.getTime() - Date.parse(record.generatedAt) <= LIVE_PROOF_MAX_AGE_MS &&
        Date.parse(record.generatedAt) <= now.getTime() + 60_000,
    );
    if (!newest)
      return {
        ...definition,
        status: 'not-run',
        reason: `the last ${definition.producedBy} was for another commit or is older than 7 days`,
        evidence: null,
      };
    return {
      ...definition,
      status: newest.proofs[definition.id] === 'passed' ? 'passed' : 'failed',
      reason: `${newest.kind} on ${newest.environment} at ${newest.generatedAt}`,
      evidence: {
        kind: newest.kind,
        generatedAt: newest.generatedAt,
        environment: newest.environment,
      },
    };
  });
}

export function assess(
  assessment: Assessment,
  outcomes: readonly TestOutcome[],
  context: {
    commit?: string | null;
    now?: Date;
    operational?: readonly OperationalRecord[];
  } = {},
): ReadinessReport {
  const problems: string[] = [];
  const now = context.now ?? new Date();
  const limitations = new Map(assessment.limitations.map((item) => [item.id, item]));
  if (limitations.size !== assessment.limitations.length) problems.push('Duplicate limitation id.');
  const liveProofs = liveProofResults(
    assessment.liveProofs ?? [],
    context.operational ?? [],
    context.commit ?? null,
    now,
  );
  const live = new Map(liveProofs.map((proof) => [proof.id, proof]));
  if (live.size !== liveProofs.length) problems.push('Duplicate live proof id.');
  for (const limitation of assessment.limitations)
    if (limitation.resolvedBy && !live.has(limitation.resolvedBy))
      problems.push(
        `${limitation.id} is resolved by an unknown live proof: ${limitation.resolvedBy}`,
      );
  const linked = new Set<string>();
  /**
   * Whether the code's own proofs meet every minimum, judged as if no live proof had run: a
   * failure in the deployed environment is not a failure of the code.
   */
  let codeMeetsMinimums = true;
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
      // Closed only by its live proof having passed, never by configuration existing.
      if (limitation.resolvedBy && live.get(limitation.resolvedBy)?.status === 'passed') return [];
      return [limitation];
    });
    for (const limitation of open)
      if (limitation.severity === 'BLOCKING') reasons.push(`Blocking limitation: ${limitation.id}`);

    const operationalProofs = (capability.operationalProofs ?? []).map(resolve);
    const softer: string[] = [];
    for (const proof of operationalProofs) {
      // A failed operational proof is a failure. One that could not run here is not a pass.
      if (proof.outcome === 'failed' || proof.outcome === 'missing')
        reasons.push(`Operational proof ${proof.outcome}: ${proof.file} › ${proof.test}`);
      else if (proof.outcome === 'skipped')
        softer.push(`Not exercised in this environment: ${proof.file} › ${proof.test}`);
    }
    const codeStatus: Status = reasons.length
      ? 'RED'
      : softer.length || open.length || capability.liveProofs?.length
        ? 'AMBER'
        : 'GREEN';
    if (codeStatus === 'RED' || RANK[codeStatus] < RANK[capability.minimum])
      codeMeetsMinimums = false;
    const capabilityLive = (capability.liveProofs ?? []).flatMap((id) => {
      const proof = live.get(id);
      if (!proof) {
        problems.push(`${capability.id} names an unknown live proof: ${id}`);
        return [];
      }
      return [proof];
    });
    for (const proof of capabilityLive)
      if (proof.status === 'failed')
        reasons.push(`Live proof failed: ${proof.id} (${proof.reason})`);
      else if (proof.status === 'not-run')
        softer.push(`Live proof not established: ${proof.id} (${proof.reason})`);
    for (const limitation of open)
      if (limitation.severity === 'ACCEPTED') softer.push(`Accepted limitation: ${limitation.id}`);
    const status: Status = reasons.length ? 'RED' : softer.length ? 'AMBER' : 'GREEN';
    return {
      id: capability.id,
      title: capability.title,
      status,
      minimum: capability.minimum,
      meetsMinimum: RANK[status] >= RANK[capability.minimum],
      reasons: [...reasons, ...softer],
      proofs,
      operationalProofs,
      liveProofs: capabilityLive,
      limitations: open,
    };
  });

  const ids = capabilities.map((capability) => capability.id);
  if (new Set(ids).size !== ids.length) problems.push('Duplicate capability id.');
  const structural = problems.length;
  for (const capability of capabilities)
    if (!capability.meetsMinimum)
      problems.push(
        `${capability.id} is ${capability.status}, below its minimum ${capability.minimum}.`,
      );
  const codeProofsPassed = structural === 0 && codeMeetsMinimums;
  // The shipped assessment names live proofs, and a test keeps it so.
  const operationalProofsPassed = liveProofs.every((proof) => proof.status === 'passed');
  return {
    generatedAt: now.toISOString(),
    commit: context.commit ?? null,
    tests: {
      passed: outcomes.filter((outcome) => outcome.status === 'passed').length,
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    },
    capabilities,
    // Every outstanding limitation is reported, whether or not a capability names it.
    limitations: assessment.limitations,
    liveProofs,
    codeProofsPassed,
    operationalProofsPassed,
    readyForControlledPilot:
      codeProofsPassed &&
      operationalProofsPassed &&
      capabilities.every((capability) => capability.status !== 'RED'),
    problems,
  };
}
