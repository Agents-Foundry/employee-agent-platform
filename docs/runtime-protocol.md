# Runtime protocol — `agents-foundry/runtime/v1`

The only contract between the control plane and an agent runtime (ADR 0002). Types live in
`packages/contracts/src/runtime/v1/protocol.ts`, and strict Zod parsers live in
`packages/contracts/src/runtime/v1/schemas.ts`.

**Status:** implemented end to end (Phase C). `apps/agent-runtime` speaks the protocol over the
signed HTTP transport described in [Transport](#transport) and
[ADR 0011](adr/0011-runtime-transport-and-workload-identity.md).

## Versioning

Every message carries `protocol: "agents-foundry/runtime/v1"`. Messages with any other version
are rejected (`PROTOCOL_VERSION_UNSUPPORTED`). Adding an optional field or a new event type is a
minor change. It still requires updating the parser, and old runtimes will not emit the new
type. Removing or re-typing a field requires `runtime/v2`.

## Commands (control plane → runtime)

| Type         | Purpose                                           | Key fields                                                                                             |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `run.submit` | Start a queued run                                | `run.task`, `run.runtimeProfile`, signed **v2** manifest, `workspace` binding, optional `run.workflow` |
| `run.resume` | Deliver a human approval decision to a paused run | `approval.approvalId`, `decision`, `decidedAt`                                                         |
| `run.cancel` | Stop a run                                        | `reason`                                                                                               |

Every command has a `commandId`, `issuedAt` and full `correlation`. `run.submit` requires an
Agent Manifest v2, and the parser checks that the manifest's organization, employee and agent
match the correlation. The runtime must verify the manifest signature before acting.
`ExecutionService.buildRunSubmitCommand` produces the command and parses it before returning.
Runs whose agents only have a v1 manifest are refused (`RUNTIME_MANIFEST_V2_REQUIRED`).
When the task names a workflow, `run.workflow` carries its definition, resolved from the
catalog bundle the manifest pins (Phase F, ADR 0014). Its `id` must equal `task.workflow`.
A workflow the bundle does not grant cancels the run instead of submitting it. The
definition is guidance for the kernel; it grants nothing.

## Events (runtime → control plane)

```json
{
  "protocol": "agents-foundry/runtime/v1",
  "eventId": "uuid",
  "runId": "uuid",
  "threadId": "uuid",
  "stepId": "uuid (required for step.*)",
  "sequence": 1,
  "type": "tool.completed",
  "occurredAt": "2026-09-23T10:00:00.000Z",
  "correlation": {
    "organizationId": "…",
    "employeeId": "…",
    "agentId": "…",
    "threadId": "…",
    "runId": "…"
  },
  "payload": {
    "toolCallId": "uuid",
    "outputDigest": "sha256",
    "durationMs": 120,
    "artifactIds": []
  }
}
```

Runtime-emittable types: `run.started`, `run.paused`, `run.resumed`, `run.completed`,
`run.failed`, `run.cancelled`, `step.started`, `step.completed`, `step.failed`, `agent.message`,
`agent.reasoning.started`, `model.requested`, `model.responded`, `tool.requested`,
`tool.started`, `tool.completed`, `tool.failed`, `artifact.created`.

Control-plane-only types (`run.created`, `user.message`, `approval.requested`,
`approval.approved`, `approval.rejected`, `approval.expired`) are rejected with `RUNTIME_EVENT_TYPE_FORBIDDEN`. A
runtime cannot record an approval on its own behalf.

### Ingestion rules (`ExecutionService.ingestRuntimeEvent`)

1. Strict parse: unknown fields, unknown types, malformed payloads, correlation that doesn't
   match `runId`/`threadId`/`stepId`, and messages over 256 KiB are rejected.
2. The correlation's `organizationId` must equal the tenant that the authenticated runtime is
   authorized for (`RUNTIME_TENANT_FORBIDDEN`). Employee, agent and thread must match the stored
   run (`RUNTIME_CORRELATION_MISMATCH`).
3. Idempotency: redelivering an `eventId` with identical content returns the stored event.
   Different content returns `RUNTIME_EVENT_CONFLICT`.
4. Ordering: `sequence` must be exactly one greater than the last accepted runtime sequence
   (`RUNTIME_EVENT_OUT_OF_ORDER`). The control plane assigns its own history sequence, because
   control-plane events interleave with runtime events.
5. State machine (`decideRuntimeEvent`, ADR 0008):
   - `run.started` only from a fresh `QUEUED` run. Over the transport, `runtimeSessionId` must
     equal the session of the runtime's lease (`RUNTIME_SESSION_MISMATCH`).
   - `run.resumed` only from `QUEUED` with reason `APPROVAL_GRANTED`, which is reachable only
     through a human approval decision. **A runtime can never release `WAITING_FOR_APPROVAL`.**
     `approvalId` must name an approved approval linked to the run
     (`RUNTIME_APPROVAL_MISMATCH`). The approved step returns to `RUNNING`.
   - `run.paused` stays in the protocol, but over the v1 transport the control plane pauses
     runs itself when it creates an approval (see below). A runtime `run.paused` is then
     rejected because the run is no longer `RUNNING`.
   - Other non-lifecycle events require `RUNNING`. Terminal runs accept nothing.
6. `artifact.created` persists artifact metadata (see [artifacts](artifacts.md)). The event
   history records only the artifact id and type, never the storage reference.

Tool inputs and outputs travel as SHA-256 digests. Raw tool I/O stays in the runtime and the
artifact store, so it never enters run history.

## Transport

Types and constants are in `packages/contracts/src/runtime/v1/transport.ts`. Routes live under
`/runtime/v1`, outside `/api`, so cookies, sessions and demo headers never apply
(ADR 0011).

### Authentication

Each runtime has an operator-registered Ed25519 public key, tenant scope and runtime profiles
(`AGENT_RUNTIME_IDENTITIES_PATH`). Each request carries:

| Header                   | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| `x-af-runtime-id`        | Registered runtime id                                    |
| `x-af-runtime-timestamp` | ISO-8601 UTC, within ±5 minutes                          |
| `x-af-runtime-nonce`     | UUID, single use                                         |
| `x-af-runtime-signature` | Base64 Ed25519 signature over `runtimeSigningInput(...)` |

The signed input is `AF-RUNTIME-V1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256(body)>`.
Every failure returns the same `401 RUNTIME_UNAUTHENTICATED`.

### Endpoints

| Route                              | Response                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /runtime/v1/commands/claim`  | `200 { command, lease }` or `204`. Order: `run.cancel` for held runs the control plane ended, `run.resume` for held runs released by an approval, then a fresh `run.submit` |
| `POST /runtime/v1/events`          | `201` (or `200` duplicate) `{ eventId, sequence, duplicate }`; only for runs the runtime leases                                                                             |
| `POST /runtime/v1/actions`         | `{ requestId, decision: ALLOWED \| DENIED \| APPROVAL_REQUIRED, risk, reason, approvalId? }`                                                                                |
| `POST /runtime/v1/actions/execute` | `{ requestId, status: SUCCEEDED \| FAILED, result?, error? }` for control-plane-executed actions (Phase D)                                                                  |
| `POST /runtime/v1/actions/grant`   | Signed single-use execution grant for an allowed or approved execution-runtime action (Phase E, ADR 0013)                                                                   |

Leases (`agent_run_leases`) bind a run to one runtime and session. A queued run that never
started can be reclaimed after 10 minutes. An undelivered command is redelivered to its holder
after 60 seconds.

### Governed actions

`POST /runtime/v1/actions` is idempotent by `requestId`: a retry returns the stored decision,
and different content returns `RUNTIME_ACTION_CONFLICT`. The run must be `RUNNING`, and the
step must be `RUNNING` and belong to it. The control plane denies (`decision: DENIED`, with a
reason code) when:

- the manifest does not verify or no longer matches the run (`MANIFEST_INVALID`);
- the tool is not in the manifest (`TOOL_NOT_IN_MANIFEST`);
- the pinned catalog bundle is missing or its digest differs;
- the tool version differs from the catalog (`TOOL_VERSION_MISMATCH`);
- the tool does not declare the action (`ACTION_NOT_GOVERNED_BY_TOOL`);
- the action has no manifest capability (`ACTION_NOT_IN_MANIFEST`);
- the policy engine fails (`POLICY_UNAVAILABLE`).

Otherwise the outcome is the more restrictive of the policy engine and the manifest
capability. `APPROVAL_REQUIRED` creates the approval and pauses the step and the run in the
same transaction. Every decision is recorded in `agent_action_requests` and audited as
`runtime.action.<decision>`.

Since Phase D, actions the control plane executes itself (for example `jira.issue.create`)
require the `parameters` field. Its canonical SHA-256 must equal `inputDigest`. Approvals for
these actions:

- expire (`expires_at`, based on risk);
- carry a summary written by the control plane;
- are executed once, through `actions/execute`.

The Action Gateway re-authorizes each execution before dispatch. See
[action-gateway.md](action-gateway.md).

The control-plane-only event `approval.expired` records an unanswered approval passing its
deadline. The paused run is then cancelled (`APPROVAL_EXPIRED`).

## Read API (browser-facing)

| Route                                   | Who                                   | Returns                                         |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `GET /api/execution/v1/threads/:id`     | Owning employee                       | Thread and its runs                             |
| `GET /api/execution/v1/runs/:id`        | Owning employee or organization admin | Run, steps, linked approvals, artifact metadata |
| `GET /api/execution/v1/runs/:id/events` | Owning employee                       | `?afterSequence=&limit=` (≤ 200) page           |

Administrators can see run governance data for approvals, but not event history. Event history
can contain agent messages, and conversations stay private to the employee, as they already
are. Resources in another tenant, or owned by another employee, return 404.
