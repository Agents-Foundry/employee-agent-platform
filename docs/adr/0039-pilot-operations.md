# ADR 0039: Operating the pilot — reconciliation screen, alerts, live validation and smoke

- Status: Accepted
- Date: 2026-10-07

## Context

ADR 0038 computes readiness from tests, and CI can only test code. The blockers left before
a controlled QA, Frontend or Backend pilot were operational: writes with an unknown outcome
had an API and no screen, there were metrics but no alerts, nothing checked a deployed
environment, and the live services (Vault, the object store, the collector, the sandbox, the
private repository, the model) were accepted limitations that nothing could ever close.

## Decision

### Writes to reconcile

The admin web app lists `/api/organization/action-reconciliations`, open ones first, with
action, target, run and conversation, time, reason and state. The list carries the summary
an approver saw, written by the control plane from validated parameters and passed through a
credential redaction; never the payload, its digest or anything of the connection. An
administrator records **Applied** (verified that it happened) or **Not applied** (verified that
it did not), once, after a confirmation that requires saying they checked. There is no retry
control. The gauge `af_action_reconciliations_open` counts what is waiting.

### Dashboards and alerts

`packages/operations` defines the dashboard panels and alerts as provider-neutral queries over
catalog metrics and labels only; a query cannot name a label that could carry an identity, a
location or content. `npm run ops:render` writes `operations.json`, Prometheus rules and a
Grafana dashboard; the recommended rendering is checked in and kept in step by a test.
Thresholds, hold times, severities and `enabled` are deployment settings in a JSON file; an
unknown alert or setting stops the render. Each alert links to a section of the
[pilot runbook](../pilot-runbook.md).

### Live validation

`npm run pilot:validate` checks a deployed environment with the services' own factories:
database connectivity, the exact migration set, both roles, that the tenant login cannot
bypass row-level security, Vault, an object-store round trip under its own prefix, a synthetic
trace, runtime identities, the signing key, that the execution runtime's pinned key verifies a
control-plane grant and refuses a forged one, the sandboxed provider, the images, the egress
proxy, the pilot's model credential, the pilot flags, and that every development fallback is
off. It changes no customer data: statements run in read-only transactions. Errors are reduced
to codes and the report is scrubbed of every secret value the run handled.

### Smoke test

`npm run pilot:smoke` drives one QA run on the deployed stack through the pilot user's API and
proves each step from the control plane's own records, including the new read model
`GET /api/execution/v1/runs/:id/actions` (decision, operation kind, credentialed checkout and
outcome per governed action, never parameters). It refuses to start unless opted in with
disposable targets declared, never for pull-request events, and only with a separate approving
administrator; it checks that no connection reaches beyond the disposable project and
repository and approves only writes aimed at them. The workflow is manual dispatch from the
default branch in the protected `pilot` environment.

### Operational proofs

The assessment names six live proofs: `vault-live`, `object-store-live` and `telemetry-live`
from validation; `sandbox-live`, `private-scm-live` and `real-model-live` from the smoke test.
`npm run readiness` reads their reports and counts one only for the commit being assessed and
for at most a week. Until then the capability is `AMBER`; a failed one is `RED`. A limitation
closes only through its live proof passing (`resolvedBy`). The report states code readiness
and operational readiness separately; a pilot is ready only when both pass.

## Consequences

- CI says "code proofs pass, not ready" for every commit: readiness for a pilot is a property
  of a deployment, and only running against it can establish it.
- Capabilities with a live proof have a minimum of `AMBER`, so CI does not need the pilot.
- The smoke test needs a real model, so its exact tool calls are the model's; it requires
  evidence of each step rather than a fixed sequence.
- No role, runtime or subsystem gained a role-specific branch.
