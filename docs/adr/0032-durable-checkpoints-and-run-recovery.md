# ADR 0032: Durable checkpoints and run recovery

- Status: Accepted
- Date: 2026-10-01

## Context

A run was tied to the runtime process that claimed it. Checkpoints were written only at an
approval pause, to that runtime's own disk. If the runtime stopped, a running run stayed
`RUNNING` for ever, and a paused run could only be resumed by the same host. Nothing detected
an abandoned run.

## Decision

### Checkpoints

1. **`CheckpointStore` has a durable adapter.** `ControlPlaneCheckpointStore` keeps checkpoints
   in the control plane, through the runtime's signed transport
   (`POST /runtime/v1/checkpoints` and `/runtime/v1/checkpoints/load`). The file adapter stays
   for development (`AGENT_RUNTIME_CHECKPOINT_STORE=local`); a run checkpointed there can only
   continue on that host.
2. **A checkpoint is bound** to its organization, thread and run, the lease session that wrote
   it, the manifest (id and SHA-256 of the signed payload), the workflow, the step in progress,
   the approval being waited for, the kernel, and the last runtime event sequence. The control
   plane checks the binding against the stored run on every save and load. The runtime checks
   it again against the body, and verifies the manifest signature with its pinned key.
3. **Checkpoints are immutable and strictly ordered.** A save is accepted only if its version
   is exactly one more than the stored one and its session is the run's current lease session.
   A trigger enforces the order in PostgreSQL as well. Two runtimes cannot both advance a run:
   the second gets `CHECKPOINT_VERSION_CONFLICT` or `CHECKPOINT_SESSION_STALE` and stops
   working on the run without recording anything.
4. **A corrupted checkpoint fails closed.** The body's SHA-256 is checked when it is stored,
   when it is read by the control plane and when it is opened by the runtime. A mismatch, an
   unknown format or a binding that does not match fails the run
   (`RUNTIME_CHECKPOINT_INVALID`); nothing is executed from it.
5. **No credential is written.** The body holds conversation content and tool results, never
   a credential: the host keeps the credentials it resolved for the run in memory and refuses
   to save a checkpoint that contains one (`RUNTIME_CHECKPOINT_SECRET`).
6. **Checkpoints are private and short-lived.** `agent_run_checkpoints` is under forced
   row-level security. No route returns a checkpoint to a browser. Only the latest two
   versions are kept, and all are deleted when the run ends.

### When the kernel checkpoints

7. The native kernel checkpoints at the start, after every model turn, before every tool call
   and after every tool result. Before a tool call it fixes and saves the step id, tool call id
   and **action request id**. Whoever continues the run repeats the same requests, and the
   control plane answers from its records:
   - `POST /runtime/v1/actions` returns the stored decision for a known request id;
   - `POST /runtime/v1/actions/execute` returns the recorded outcome instead of calling the
     connector again;
   - `POST /runtime/v1/actions/grant` returns the one grant of the request, which an execution
     runtime uses once.

   There is no second replay mechanism.

8. A tool call whose step already ended at the control plane, but whose result was not yet
   checkpointed, is **never run again**. The model is told the outcome is unknown
   (`TOOL_OUTCOME_UNKNOWN`).

### Recovery

9. **Leases are kept alive explicitly.** A runtime sends `POST /runtime/v1/heartbeat` with the
   runs it is executing. Events and checkpoints also renew the lease. A run the runtime names
   but no longer holds comes back as `lost`, and the runtime stops it.
10. **An expired lease makes the run reclaimable** if it has a durable checkpoint. The next
    authorized runtime to poll (same profile, serving the organization) is given the run under
    a new lease session:
    - a `RUNNING` run gets the new `run.recover` command, with the steps the control plane
      still holds open;
    - a run released by an approval (`QUEUED` / `APPROVAL_GRANTED`) gets `run.resume`.

    The previous session can no longer send events, checkpoints, action requests or
    heartbeats for the run. The handover is audited as `runtime.run.recovered`.

11. **The runtime continues from the checkpoint.** It fails the open steps the checkpoint does
    not name (`RUNTIME_RECOVERED`), does not emit `run.started` again, and resumes the kernel.
12. **The reaper** runs whenever a runtime polls and once a minute in the API process. It
    cancels:
    - a `RUNNING` run whose lease expired and that has no durable checkpoint (`RUNTIME_LOST`);
    - an abandoned run no runtime picked up within 24 hours (`RUNTIME_LOST`);
    - a run that was already handed on three times (`RUNTIME_RECOVERY_EXHAUSTED`);
    - a run whose manifest no longer matches (`MANIFEST_INVALID`).

    A paused run with no answer is still ended by approval expiry, as before.

## Run recovery states

| Run status                  | Lease        | Checkpoint | What happens                                           |
| --------------------------- | ------------ | ---------- | ------------------------------------------------------ |
| `RUNNING`                   | live         | any        | Stays with its runtime                                 |
| `RUNNING`                   | expired      | durable    | Next authorized runtime gets `run.recover`             |
| `RUNNING`                   | expired      | none       | Cancelled, `RUNTIME_LOST`                              |
| `RUNNING`                   | expired ≥24h | durable    | Cancelled, `RUNTIME_LOST`                              |
| `RUNNING`, 3 recoveries     | expired      | durable    | Cancelled, `RUNTIME_RECOVERY_EXHAUSTED`                |
| `WAITING_FOR_APPROVAL`      | any          | any        | Waits for the decision or the approval's expiry        |
| `QUEUED`/`APPROVAL_GRANTED` | live         | any        | `run.resume` to the holder                             |
| `QUEUED`/`APPROVAL_GRANTED` | expired      | durable    | `run.resume` to the holder or the next runtime to poll |
| `QUEUED`/`APPROVAL_GRANTED` | expired      | none       | `run.resume` to the holder only; cancelled after 24h   |

## Consequences

- Checkpoint bodies, which contain conversation content, are now stored in PostgreSQL while a
  run is active. They are not encrypted by the application.
- Recovery takes as long as a lease lasts: ten minutes after the runtime's last sign of life.
- A model turn that was in progress when the runtime stopped is asked again. Its tokens are
  spent twice; no external effect is repeated.
- A grant that expired before the run was recovered is not reissued: the tool call fails with
  `GRANT_EXPIRED` and the model decides what to do.
- Kernel state has a new format. Runs paused by an older runtime fail closed on resume.
- `run.recover` and the heartbeat, checkpoint and credential routes are additions to
  `agents-foundry/runtime/v1`. Runtimes and the control plane must be upgraded together.
- Every checkpoint is one more request to the control plane: two per tool call, one per model
  turn.
