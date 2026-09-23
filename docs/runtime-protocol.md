# Runtime protocol — `agents-foundry/runtime/v1`

The only contract between the control plane and an agent runtime (ADR 0002). Types live in
`packages/contracts/src/runtime/v1/protocol.ts`, and strict Zod parsers live in
`packages/contracts/src/runtime/v1/schemas.ts`.

**Status:** contracts, parsers and control-plane ingestion logic are implemented and tested.
No runtime process speaks the protocol yet, and no HTTP transport is exposed (see
[Transport](#transport)).

## Versioning

Every message carries `protocol: "agents-foundry/runtime/v1"`. Messages with any other version
are rejected (`PROTOCOL_VERSION_UNSUPPORTED`). Adding an optional field or a new event type is a
minor change. It still requires updating the parser, and old runtimes will not emit the new
type. Removing or re-typing a field requires `runtime/v2`.

## Commands (control plane → runtime)

| Type         | Purpose                                             | Key fields                                      |
| ------------ | --------------------------------------------------- | ----------------------------------------------- |
| `run.submit` | Start a queued run                                   | `run.task`, `run.runtimeProfile`, signed **v2** manifest, `workspace` binding |
| `run.resume` | Deliver a human approval decision to a paused run    | `approval.approvalId`, `decision`, `decidedAt`  |
| `run.cancel` | Stop a run                                           | `reason`                                        |

Every command has a `commandId`, `issuedAt` and full `correlation`. `run.submit` requires an
Agent Manifest v2, and the parser checks that the manifest's organization, employee and agent
match the correlation. The runtime must verify the manifest signature before acting.
`ExecutionService.buildRunSubmitCommand` produces the command and parses it before returning.
Runs whose agents only have a v1 manifest are refused (`RUNTIME_MANIFEST_V2_REQUIRED`).

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
  "correlation": { "organizationId": "…", "employeeId": "…", "agentId": "…", "threadId": "…", "runId": "…" },
  "payload": { "toolCallId": "uuid", "outputDigest": "sha256", "durationMs": 120, "artifactIds": [] }
}
```

Runtime-emittable types: `run.started`, `run.paused`, `run.resumed`, `run.completed`,
`run.failed`, `run.cancelled`, `step.started`, `step.completed`, `step.failed`, `agent.message`,
`agent.reasoning.started`, `model.requested`, `model.responded`, `tool.requested`,
`tool.started`, `tool.completed`, `tool.failed`, `artifact.created`.

Control-plane-only types (`run.created`, `user.message`, `approval.requested`,
`approval.approved`, `approval.rejected`) are rejected with `RUNTIME_EVENT_TYPE_FORBIDDEN`. A
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
   - `run.started` only from a fresh `QUEUED` run.
   - `run.resumed` only from `QUEUED` with reason `APPROVAL_GRANTED`, which is reachable only
     through a human approval decision. **A runtime can never release `WAITING_FOR_APPROVAL`.**
   - Other non-lifecycle events require `RUNNING`. Terminal runs accept nothing.
6. `artifact.created` persists artifact metadata (see [artifacts](artifacts.md)). The event
   history records only the artifact id and type, never the storage reference.

Tool inputs and outputs travel as SHA-256 digests. Raw tool I/O stays in the runtime and the
artifact store, so it never enters run history.

## Transport

Phase A deliberately exposes **no** HTTP ingestion route. An ingestion endpoint must
authenticate a runtime workload identity (for example mTLS or signed service tokens) scoped to
the tenants that runtime serves. Browser sessions must never be able to write run history.
Phase C adds that transport around the existing service method.

## Read API (browser-facing)

| Route                                    | Who                                  | Returns                                   |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------- |
| `GET /api/execution/v1/threads/:id`      | Owning employee                      | Thread and its runs                       |
| `GET /api/execution/v1/runs/:id`         | Owning employee or organization admin | Run, steps, linked approvals, artifact metadata |
| `GET /api/execution/v1/runs/:id/events`  | Owning employee                      | `?afterSequence=&limit=` (≤ 200) page     |

Administrators can see run governance data for approvals, but not event history. Event history
can contain agent messages, and conversations stay private to the employee, as they already
are. Resources in another tenant, or owned by another employee, return 404.
