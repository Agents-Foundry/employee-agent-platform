# QA pilot release gate register — 9 November 2026

**Release status: NO-GO for customer data and production onboarding.** This is a task register, not evidence of readiness.

| Gate | Required evidence | Status |
|---|---|---|
| [AF-REL-01 Six live proofs](https://github.com/Agents-Foundry/employee-agent-platform/issues/41) | Validation, smoke and SHA-aligned readiness=true | OPEN |
| [AF-REL-02 Security and privacy](https://github.com/Agents-Foundry/employee-agent-platform/issues/42) | Independent review and severity dispositions | OPEN |
| [AF-REL-03 Backup and recovery](https://github.com/Agents-Foundry/employee-agent-platform/issues/43) | Full isolated restore and measured RPO/RTO | OPEN |
| [AF-REL-04 Real QA workflow](https://github.com/Agents-Foundry/employee-agent-platform/issues/44) | Jira, checkout, Playwright and approved external write | OPEN |
| [AF-REL-05 Monitoring and incident response](https://github.com/Agents-Foundry/employee-agent-platform/issues/45) | Live fault injection and delivered alerts | OPEN |
| [AF-REL-06 Pilot UX and signoff](https://github.com/Agents-Foundry/employee-agent-platform/issues/46) | Manual accessibility, design and PO approval | OPEN |
| [AF-REL-07 Desktop distribution](https://github.com/Agents-Foundry/employee-agent-platform/issues/47) | Signed installer and target OS test or excluded pilot scope | OPEN |
| [AF-REL-08 Enterprise identity](https://github.com/Agents-Foundry/employee-agent-platform/issues/48) | MFA/RBAC controls or scoped compensations | OPEN |
| [AF-REL-09 Client lifecycle](https://github.com/Agents-Foundry/employee-agent-platform/issues/49) | Onboarding, offboarding, data terms and support | OPEN |
| [AF-REL-10 Multi-role expansion](https://github.com/Agents-Foundry/employee-agent-platform/issues/50) | Later-stage validated capability coverage | OPEN |

## Approval policy

- Internal demonstrations may only use disposable data with clear prototype/pilot labelling.
- A controlled internal QA pilot needs passing operational proofs and security boundary validation for the exact deployed commit.
- An external design-partner pilot requires all six P0 gates, applicable client lifecycle controls, and explicit written pilot approval.
- A general production release requires separate measured reliability, restoration, security, capacity, release and operational support qualification.
- Do not equate successful CI/prototype test results with independent review or deployed production evidence.

## Pending related work

- [Infrastructure PR #1](https://github.com/Agents-Foundry/af-pilot-infra/pull/1): prevent host validation from swallowing failures; live verification required.
- [Prototype PR #88](https://github.com/Agents-Foundry/prototypes/pull/88): organisation admin design updates awaiting review.

## Evidence protocol

For each issue attach accountable owner, reviewer, exact source SHA and deployed host configuration, dated command output, positive and negative test artifacts, defect dispositions and explicit signoff. The live readiness system requires six deployment-bound proofs, each no more than seven days old. Never prefill human approvals.

Do not close gates solely because this file, an issue, or a CI workflow exists.

## AF-REL-01 live proof collection checklist (not yet executed)

Use the **same immutable deployed commit** and environment for every proof. Do not paste secrets, tokens, unredacted traces, or customer data into issues or PRs.

| Proof identifier | Minimum evidence to preserve | Current result |
|---|---|---|
| `vault-live` | Authorized secret lease/use, denied or revoked access, redacted host report | NOT RUN |
| `object-store-live` | Artifact write/read and denied cross-scope access, redacted host report | NOT RUN |
| `telemetry-live` | Trace/metric emission and verified collection path, redacted host report | NOT RUN |
| `sandbox-live` | Isolated execution plus denied boundary/egress attempt, redacted host report | NOT RUN |
| `private-scm-live` | Authorized private checkout and rejected unauthorized scope, redacted host report | NOT RUN |
| `real-model-live` | Approved model request and enforced budget/denial path, redacted host report | NOT RUN |

**Execution order:** (1) capture release SHA, host identity and UTC timestamp; (2) run the documented control-plane and execution-host validators, including negative paths; (3) run the protected Pilot smoke workflow and preserve its artifact; (4) verify all six proof identifiers against the same deployed SHA; (5) run `npm run readiness` on that SHA and preserve the full redacted output; (6) obtain independent review and explicit acceptance. The three readiness flags `codeProofsPassed`, `operationalProofsPassed` and `readyForControlledPilot` must all be true before claiming AF-REL-01 passed.

**Evidence freshness:** Each live proof must be no more than seven days old at the time of acceptance. If the deployed SHA changes, or a proof expires, re-run the affected evidence rather than reusing stale CI artifacts. A green infrastructure PR check demonstrates wrapper behavior only; it is not any of the six live proofs.
