# ADR 0038: A pilot-readiness assessment computed from test results

- Status: Accepted
- Date: 2026-10-02

## Context

"Ready for a pilot" was a judgement written in a report. It could say a capability exists
because a type, a table or a route exists, and it could go stale without anyone noticing.

## Decision

1. `pilot-readiness/assessment.json` names, for each capability a pilot depends on, the tests
   that prove it, and the limitations that are still open. It contains no status.
2. Every test run writes its results to `.readiness/results/`. `npm run readiness` (part of
   `npm run check`, and so of CI) computes each capability's status from those results and
   writes `.readiness/pilot-readiness-report.json`, which CI keeps as a build artifact.
3. Status rules:

   | Status  | When                                                                                                  |
   | ------- | ----------------------------------------------------------------------------------------------------- |
   | `GREEN` | Every proof ran and passed, and no open limitation is linked to the capability                        |
   | `AMBER` | Every required proof passed, but a limitation is accepted, or an operational proof could not run here |
   | `RED`   | A proof failed, was skipped, was renamed or never existed; or a blocking limitation is linked         |

   A proof is a test file and an exact test title. A whole `describe` block can be a proof: all
   of it must pass, and at least a stated number of tests must have run.

4. An **operational proof** needs infrastructure a build may not have, such as Docker with the
   sandbox images. Where it cannot run it is reported as not exercised, which is `AMBER`, never
   as passed.
5. Each capability has a `minimum`. The build fails when a capability is below it, or names a
   limitation nobody defined. A capability that carries an accepted limitation cannot have a
   minimum of `GREEN`.
6. `readyForControlledPilot` is true when no capability is `RED`. The report lists every
   outstanding limitation and what must be done about it before a pilot.

The assessed capabilities are tenant isolation, manifest and signature integrity, policy and
approval controls, model budget controls, credential isolation, private repositories,
execution sandboxing, recovery, artifacts, observability and evaluation health.

## Consequences

- Nobody can mark a capability green. Deleting or renaming a proof turns it red in the same
  build, and a test in the control-plane suite fails as soon as the assessment names a test
  that does not exist.
- Limitations are judgements: someone decides that one is accepted for a controlled pilot.
  That decision is a reviewed change to the assessment file.
- The assessment proves what the tests exercise. Live services (the pilot's object store,
  Vault, collector, model) are not exercised by CI; each is an accepted limitation with a
  step to take before the pilot.
