# ADR 0012: Action Gateway execution, Policy v2 and connector secrets

- Status: Accepted
- Date: 2026-09-25

## Context

Phase C let a runtime ask whether a governed action may proceed. The runtime still performed
the action itself, and approvals were open-ended and tied to the run, not to the exact
payload. External writes (issue trackers, source control) need credentials. Those must never
reach a runtime, a model, a browser or the audit trail, and a write must never run twice or
run after its approval is stale.

## Decision

1. **Control-plane-executed actions.** A registry (`actions/action-registry.ts`) lists the
   semantic actions the control plane performs itself. Each entry declares:
   - the connector provider;
   - the connector capability the manifest must grant (for example `issueTracker.write`);
   - a strict parameter schema with no transforms;
   - the target resource and whether it is in scope;
   - a summary written by the control plane.

   `jira.issue.create` is the first entry. Actions not listed there stay runtime-executed, as
   in Phase C.

2. **Payload-bound decisions.** For registered actions the runtime sends `parameters` with the
   action request, and the canonical SHA-256 of the parameters must equal `inputDigest`. The
   control plane validates the parameters and stores them only for decisions that are not
   denied. It writes the approval summary itself, from the validated payload, so model text
   never becomes the approver's description. Execution uses the stored payload, so what runs
   is exactly what was approved.
3. **Policy v2** (`evaluateActionPolicy`) is deterministic and never calls a model. Its inputs
   are:
   - the platform decision for the action;
   - the manifest's pinned capability;
   - an organization override, which can only be `REQUIRE_APPROVAL` or `DENY`;
   - whether the resource is in scope (for example, the connection's allowed projects).

   Each input can only keep or tighten the outcome. The decision carries `policyId`,
   `policyVersion` and conditions: an approval TTL by risk (LOW/MEDIUM 24 h, HIGH 8 h,
   CRITICAL 1 h) and binding to the input digest.

4. **Expiring approvals.** Gateway approvals get `expires_at`. Expiry is applied lazily wherever
   approvals are listed, decided, claimed or executed, so no scheduler is needed. An expired
   approval becomes `EXPIRED` and records `approval.expired`, and its paused run is cancelled
   (`APPROVAL_EXPIRED`), which reaches the runtime as `run.cancel`. Late decisions return
   `409 APPROVAL_EXPIRED`. Legacy QA approvals have no expiry and behave as before.
5. **Single-use execution.** `POST /runtime/v1/actions/execute` re-authorizes against current
   state (policy, overrides, manifest, connection, scope, approval status and expiry), then
   inserts an execution row as `DISPATCHING` _before_ calling the connector. A trigger lets that
   row move only once, to `SUCCEEDED` or `FAILED`. Refusals are recorded as `FAILED` too.
   Retries return the recorded outcome. A crash mid-dispatch leaves the row `DISPATCHING`, and
   it is never re-sent automatically: a missed write is safer than a duplicate one.
6. **Connections and secrets.** Organization admins configure connections, holding a
   `secret://name` reference, never a value. The `SecretResolver` resolves a reference only
   within the owning organization, at dispatch time. The development implementation is an
   operator file (`CONNECTOR_SECRETS_PATH`); a managed vault replaces it without changing
   references. Unresolved secrets fail closed (`SECRET_UNRESOLVED`). Connection URLs must be
   HTTPS DNS names without credentials, and private-looking hosts are rejected to limit
   server-side request forgery. One active connection per provider keeps selection
   deterministic.
7. **Connectors hold no authorization logic.** `IssueTrackerConnector` and
   `JiraIssueTrackerConnector` only translate a validated draft into a provider call. Their
   errors carry a code and HTTP status only, never provider bodies, which can echo
   credentials.

## Consequences

- Runtimes never see connector credentials, and an approval authorizes exactly one payload,
  once, until it expires.
- Tightening policy takes effect immediately, even for already-approved requests
  (`POLICY_DENIED`, or `APPROVAL_REQUIRED` for a request that was previously allowed).
- QA Engineer 1.2.0 adds `issueTracker.write`. Agents on 1.1.0 are denied issue creation
  (`CONNECTOR_CAPABILITY_MISSING`) until a new agent is created on 1.2.0.
- DNS rebinding and IPv6 private ranges behind public names are not yet defended. Production
  deployments should add an egress proxy with an allow-list.
