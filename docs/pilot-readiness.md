# Pilot readiness

Whether the repository is ready for a first controlled organization pilot is computed, not
declared ([ADR 0038](adr/0038-pilot-readiness-assessment.md)).

```bash
npm run test        # writes test results to .readiness/results/
npm run readiness   # writes .readiness/pilot-readiness-report.json and prints a summary
npm run check       # build, test and readiness together; this is what CI runs
```

- [`pilot-readiness/assessment.json`](../pilot-readiness/assessment.json) lists each
  capability, the tests that prove it and the limitations that are still open.
- The report gives each capability a status. `GREEN`: every proof ran and passed and nothing
  is open. `AMBER`: proven, with an accepted limitation or a proof that could not run in this
  environment. `RED`: a proof failed, was skipped or is missing, or a limitation blocks a
  pilot.
- The build fails when a capability falls below its minimum. CI keeps the report as the
  `pilot-readiness` artifact.

To add a capability or change a proof, edit the assessment file. A proof is a test file and
the exact title of a test in it; a test in the control-plane suite fails if the assessment
names a test that does not exist.

## Code proofs and operational proofs

CI proves the code. It cannot prove the pilot's environment, so six capabilities also name a
**live proof** that only a run against the deployed pilot can establish
([ADR 0039](adr/0039-pilot-operations.md)):

| Live proof          | Established by           | What it shows                                                    |
| ------------------- | ------------------------ | ---------------------------------------------------------------- |
| `vault-live`        | `npm run pilot:validate` | Vault resolves the health-check secret and the pilot's model key |
| `object-store-live` | `npm run pilot:validate` | The pilot bucket stores, returns and deletes an object           |
| `telemetry-live`    | `npm run pilot:validate` | The pilot's collector accepts a trace                            |
| `sandbox-live`      | `npm run pilot:smoke`    | Dependencies install, tests and Playwright run in the sandbox    |
| `private-scm-live`  | `npm run pilot:smoke`    | A private repository is checked out with a brokered credential   |
| `real-model-live`   | `npm run pilot:smoke`    | A run completes with the pilot's real model                      |

Both commands write their report to `.readiness/operational/`; `npm run readiness` reads it
(or `--operational <directory>`). A live proof counts only when the report names the commit
being assessed and is at most seven days old. Until then the capability is `AMBER`, never
`GREEN`, however complete the configuration looks; a failed live proof is `RED`. A limitation
such as `vault-not-live` is closed only by its live proof having passed.

The report says separately whether code proofs pass (`codeProofsPassed`) and whether every
operational proof passed (`operationalProofsPassed`). `readyForControlledPilot` needs both.
In CI the operational proofs have not run, so CI reports "code proofs pass, not ready".

## Before a pilot

Follow the [pilot runbook](pilot-runbook.md). In short:

1. Deploy, then run `npm run pilot:validate` on the control-plane host and on each execution
   host, and `npm run pilot:smoke` from the `Pilot smoke` workflow.
2. Copy both reports into `.readiness/operational/` and run `npm run readiness` for the
   deployed commit. Start only if it says "Ready for a controlled pilot".
3. Load `operations/` into the monitoring system, with the deployment's thresholds.
4. Use organization-managed model credentials; employee-held keys are refused.
5. Run the model-quality workflow for the pilot's model and review its scores.
