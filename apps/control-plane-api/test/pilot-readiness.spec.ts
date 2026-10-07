import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assess,
  operationalRecord,
  outcomesFromVitest,
  type Assessment,
  type TestOutcome,
} from '../../../packages/readiness/src/assess.js';

const root = join(import.meta.dirname, '..', '..', '..');
const shipped = JSON.parse(
  readFileSync(join(root, 'pilot-readiness', 'assessment.json'), 'utf8'),
) as Assessment;

const passed = (file: string, title: string, ancestors: string[] = []): TestOutcome => ({
  file,
  title,
  ancestors,
  status: 'passed',
});
const sample: Assessment = {
  version: 1,
  description: 'sample',
  capabilities: [
    {
      id: 'isolation',
      title: 'Isolation',
      minimum: 'GREEN',
      proofs: [
        { file: 'a.spec.ts', test: 'keeps tenants apart' },
        { file: 'a.spec.ts', test: 'refuses foreign writes' },
      ],
    },
    {
      id: 'sandbox',
      title: 'Sandbox',
      minimum: 'AMBER',
      proofs: [{ file: 'b.spec.ts', test: 'builds a locked-down run' }],
      operationalProofs: [{ file: 'b.spec.ts', test: 'runs in a real container' }],
      limitations: ['host-checkout'],
    },
    {
      id: 'evaluations',
      title: 'Evaluations',
      minimum: 'GREEN',
      proofs: [{ file: 'c.spec.ts', test: 'covers every role' }],
      proofSuites: [{ file: 'c.spec.ts', describe: 'scenarios', minimumTests: 2 }],
    },
  ],
  limitations: [
    { id: 'host-checkout', severity: 'ACCEPTED', summary: 's', beforePilot: 'b' },
    { id: 'no-mcp', severity: 'INFORMATIONAL', summary: 's', beforePilot: 'b' },
  ],
};
const allPassing = [
  passed('a.spec.ts', 'keeps tenants apart'),
  passed('a.spec.ts', 'refuses foreign writes'),
  passed('b.spec.ts', 'builds a locked-down run'),
  passed('b.spec.ts', 'runs in a real container'),
  passed('c.spec.ts', 'covers every role'),
  passed('c.spec.ts', 'scenario one', ['scenarios']),
  passed('c.spec.ts', 'scenario two', ['scenarios']),
];
const statuses = (outcomes: TestOutcome[], assessment = sample) =>
  Object.fromEntries(
    assess(assessment, outcomes).capabilities.map((capability) => [
      capability.id,
      capability.status,
    ]),
  );

describe('pilot readiness (ADR 0038)', () => {
  it('is green only for proofs that ran and passed, with no open limitation', () => {
    const report = assess(sample, allPassing, { commit: 'abc', now: new Date(0) });
    expect(statuses(allPassing)).toEqual({
      isolation: 'GREEN',
      // Every proof passed, but an accepted limitation is still open.
      sandbox: 'AMBER',
      evaluations: 'GREEN',
    });
    expect(report).toMatchObject({
      commit: 'abc',
      generatedAt: '1970-01-01T00:00:00.000Z',
      tests: { passed: 7, failed: 0, skipped: 0 },
      readyForControlledPilot: true,
      problems: [],
    });
    // Every limitation is reported, including those no capability names.
    expect(report.limitations.map((item) => item.id)).toEqual(['host-checkout', 'no-mcp']);
  });

  it('turns red when a proof failed, was skipped, was renamed or never existed', () => {
    const without = (title: string) => allPassing.filter((outcome) => outcome.title !== title);
    const withStatus = (title: string, status: TestOutcome['status']) =>
      allPassing.map((outcome) => (outcome.title === title ? { ...outcome, status } : outcome));
    for (const outcomes of [
      withStatus('keeps tenants apart', 'failed'),
      withStatus('keeps tenants apart', 'skipped'),
      without('keeps tenants apart'),
      // A test of that name in another file proves nothing here.
      [...without('keeps tenants apart'), passed('z.spec.ts', 'keeps tenants apart')],
    ]) {
      const report = assess(sample, outcomes);
      expect(report.capabilities[0]).toMatchObject({ status: 'RED', meetsMinimum: false });
      expect(report.readyForControlledPilot).toBe(false);
      expect(report.problems).toEqual(['isolation is RED, below its minimum GREEN.']);
    }
    // A capability with no proof at all is never green.
    expect(
      statuses(allPassing, {
        ...sample,
        capabilities: [{ id: 'claimed', title: 'Claimed', minimum: 'RED', proofs: [] }],
      }),
    ).toEqual({ claimed: 'RED' });
  });

  it('is amber when an operational proof could not run here, and red when it failed', () => {
    const operational = (status: TestOutcome['status']) =>
      allPassing.map((outcome) =>
        outcome.title === 'runs in a real container' ? { ...outcome, status } : outcome,
      );
    const noLimitation: Assessment = {
      ...sample,
      capabilities: sample.capabilities.map(
        ({ limitations: _dropped, ...capability }) => capability,
      ),
    };
    expect(statuses(allPassing, noLimitation)['sandbox']).toBe('GREEN');
    expect(statuses(operational('skipped'), noLimitation)['sandbox']).toBe('AMBER');
    expect(statuses(operational('failed'), noLimitation)['sandbox']).toBe('RED');
    expect(
      statuses(
        allPassing.filter((outcome) => outcome.title !== 'runs in a real container'),
        noLimitation,
      )['sandbox'],
    ).toBe('RED');
  });

  it('counts a whole suite as proof only when all of it passed and enough of it ran', () => {
    expect(
      statuses(allPassing.filter((outcome) => outcome.title !== 'scenario two')),
    ).toMatchObject({
      evaluations: 'RED',
    });
    expect(
      statuses(
        allPassing.map((outcome) =>
          outcome.title === 'scenario two' ? { ...outcome, status: 'failed' as const } : outcome,
        ),
      ),
    ).toMatchObject({ evaluations: 'RED' });
  });

  it('is red for a blocking limitation and refuses limitations nobody defined', () => {
    const blocking: Assessment = {
      ...sample,
      limitations: [{ ...sample.limitations[0]!, severity: 'BLOCKING' }, sample.limitations[1]!],
    };
    const report = assess(blocking, allPassing);
    expect(report.capabilities[1]!.status).toBe('RED');
    expect(report.readyForControlledPilot).toBe(false);
    const unknown: Assessment = {
      ...sample,
      capabilities: [{ ...sample.capabilities[0]!, limitations: ['never-defined'] }],
    };
    expect(assess(unknown, allPassing).problems).toEqual([
      'isolation names an unknown limitation: never-defined',
    ]);
  });

  it('reads Vitest JSON results with repository-relative paths', () => {
    const outcomes = outcomesFromVitest(
      {
        testResults: [
          {
            name: 'C:\\work\\repo\\apps\\api\\test\\a.spec.ts',
            assertionResults: [
              { title: 'one', status: 'passed', ancestorTitles: ['suite'] },
              { title: 'two', status: 'failed', ancestorTitles: [] },
              { title: 'three', status: 'pending', ancestorTitles: [] },
              { title: 'four', status: 'skipped' },
            ],
          },
        ],
      },
      'C:\\work\\repo',
    );
    expect(outcomes).toEqual([
      { file: 'apps/api/test/a.spec.ts', title: 'one', ancestors: ['suite'], status: 'passed' },
      { file: 'apps/api/test/a.spec.ts', title: 'two', ancestors: [], status: 'failed' },
      { file: 'apps/api/test/a.spec.ts', title: 'three', ancestors: [], status: 'skipped' },
      { file: 'apps/api/test/a.spec.ts', title: 'four', ancestors: [], status: 'skipped' },
    ]);
    expect(() => outcomesFromVitest({}, '/repo')).toThrow('READINESS_RESULTS_INVALID');
    expect(() => outcomesFromVitest({ testResults: [{}] }, '/repo')).toThrow(
      'READINESS_RESULTS_INVALID',
    );
  });

  describe('live proofs (ADR 0039)', () => {
    const withLive: Assessment = {
      ...sample,
      capabilities: [
        sample.capabilities[0]!,
        { ...sample.capabilities[1]!, liveProofs: ['sandbox-live'] },
        sample.capabilities[2]!,
      ],
      limitations: [
        { ...sample.limitations[0]!, resolvedBy: 'sandbox-live' },
        sample.limitations[1]!,
      ],
      liveProofs: [
        { id: 'sandbox-live', title: 'Sandbox on the pilot', producedBy: 'pilot:smoke' },
      ],
    };
    const now = new Date('2026-10-07T12:00:00.000Z');
    const record = (status: 'passed' | 'failed' | 'not-run', extra: object = {}) => ({
      kind: 'pilot-smoke' as const,
      generatedAt: '2026-10-07T10:00:00.000Z',
      commit: 'abc',
      environment: 'pilot',
      proofs: { 'sandbox-live': status },
      ...extra,
    });
    const run = (operational: ReturnType<typeof record>[]) =>
      assess(withLive, allPassing, { commit: 'abc', now, operational });

    it('is never green, nor ready, until the proof ran against the pilot', () => {
      const report = run([]);
      expect(report.capabilities[1]).toMatchObject({ status: 'AMBER', meetsMinimum: true });
      expect(report.capabilities[1]!.reasons).toContain(
        'Live proof not established: sandbox-live (run pilot:smoke against the pilot)',
      );
      expect(report).toMatchObject({
        codeProofsPassed: true,
        operationalProofsPassed: false,
        readyForControlledPilot: false,
        problems: [],
      });
      // Not running it, or running it without proving it, is the same.
      expect(run([record('not-run')]).liveProofs[0]!.status).toBe('not-run');
    });

    it('turns green and closes the limitation it resolves only when it passed', () => {
      const report = run([record('passed')]);
      expect(report.capabilities[1]).toMatchObject({ status: 'GREEN', limitations: [] });
      expect(report.liveProofs[0]).toMatchObject({
        status: 'passed',
        evidence: { kind: 'pilot-smoke', environment: 'pilot' },
      });
      expect(report).toMatchObject({
        operationalProofsPassed: true,
        readyForControlledPilot: true,
      });
    });

    it('is red when it failed, and the newest record for this commit decides', () => {
      const failed = run([record('failed')]);
      expect(failed.capabilities[1]!.status).toBe('RED');
      expect(failed).toMatchObject({ codeProofsPassed: true, readyForControlledPilot: false });
      const later = run([
        record('failed'),
        record('passed', { generatedAt: '2026-10-07T11:00:00.000Z' }),
      ]);
      expect(later.liveProofs[0]!.status).toBe('passed');
    });

    it('ignores records of another commit, stale records and malformed ones', () => {
      for (const stale of [
        record('passed', { commit: 'other' }),
        record('passed', { commit: null }),
        record('passed', { generatedAt: '2026-09-20T10:00:00.000Z' }),
        record('passed', { generatedAt: '2026-10-08T10:00:00.000Z' }),
      ]) {
        const report = run([stale]);
        expect(report.liveProofs[0]!.status).toBe('not-run');
        expect(report.readyForControlledPilot).toBe(false);
      }
      expect(run([record('passed', { commit: 'other' })]).liveProofs[0]!.reason).toContain(
        'another commit or is older than 7 days',
      );
      expect(operationalRecord({ kind: 'pilot-smoke', generatedAt: 'x', proofs: {} })).toBeNull();
      expect(
        operationalRecord({ kind: 'other', generatedAt: now.toISOString(), proofs: {} }),
      ).toBeNull();
      expect(
        operationalRecord({
          kind: 'pilot-validate',
          generatedAt: now.toISOString(),
          commit: 'abc',
          environment: 'pilot',
          proofs: { 'vault-live': 'passed', forged: 'GREEN' },
        }),
      ).toMatchObject({ proofs: { 'vault-live': 'passed' } });
      expect(
        assess(
          { ...withLive, limitations: [{ ...sample.limitations[0]!, resolvedBy: 'nowhere' }] },
          allPassing,
        ).problems,
      ).toContain('host-checkout is resolved by an unknown live proof: nowhere');
    });
  });

  describe('the shipped assessment', () => {
    it('covers every area a pilot depends on', () => {
      expect(shipped.capabilities.map((capability) => capability.id)).toEqual([
        'tenant-isolation',
        'manifest-integrity',
        'policy-approval',
        'model-budget',
        'credential-isolation',
        'private-repositories',
        'execution-sandboxing',
        'recovery',
        'artifacts',
        'observability',
        'evaluation-health',
      ]);
      for (const capability of shipped.capabilities) {
        expect(capability.proofs.length, capability.id).toBeGreaterThan(3);
        expect(['GREEN', 'AMBER']).toContain(capability.minimum);
      }
      const known = new Set(shipped.limitations.map((limitation) => limitation.id));
      expect(known.size).toBe(shipped.limitations.length);
      for (const capability of shipped.capabilities)
        for (const id of capability.limitations ?? []) expect(known.has(id), id).toBe(true);
      // A capability that carries an accepted limitation cannot be required to be green.
      for (const capability of shipped.capabilities)
        if (capability.limitations?.length) expect(capability.minimum, capability.id).toBe('AMBER');
      // ADR 0039: the live environment is proven by running against it, for these six.
      expect(shipped.liveProofs?.map((proof) => proof.id)).toEqual([
        'vault-live',
        'object-store-live',
        'telemetry-live',
        'sandbox-live',
        'private-scm-live',
        'real-model-live',
      ]);
      const live = new Set(shipped.liveProofs!.map((proof) => proof.id));
      const named = shipped.capabilities.flatMap((capability) => capability.liveProofs ?? []);
      expect(new Set(named)).toEqual(live);
      // A build cannot run them, so a capability that needs one cannot be required to be green.
      for (const capability of shipped.capabilities)
        if (capability.liveProofs?.length) expect(capability.minimum, capability.id).toBe('AMBER');
      for (const limitation of shipped.limitations)
        if (limitation.resolvedBy)
          expect(live.has(limitation.resolvedBy), limitation.id).toBe(true);
    });

    it('names only tests that exist, so a renamed or deleted proof is noticed at once', () => {
      const sources = new Map<string, string>();
      const source = (file: string) => {
        if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), 'utf8'));
        return sources.get(file)!;
      };
      for (const capability of shipped.capabilities) {
        for (const proof of [...capability.proofs, ...(capability.operationalProofs ?? [])]) {
          expect(proof.file).toMatch(/^apps\/[a-z-]+\/test\/[a-z0-9.-]+\.spec\.ts$/);
          expect(
            source(proof.file).includes(`it('${proof.test}'`) ||
              source(proof.file).includes(`it("${proof.test}"`),
            `${capability.id}: ${proof.file} › ${proof.test}`,
          ).toBe(true);
        }
        for (const suite of capability.proofSuites ?? [])
          expect(source(suite.file), suite.describe).toContain(`describe('${suite.describe}'`);
      }
    });
  });
});
