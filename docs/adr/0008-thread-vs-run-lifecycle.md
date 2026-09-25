# ADR 0008: Thread vs run lifecycle

- Status: Accepted
- Date: 2026-09-23

## Context

Follow-up requests ("also check the mobile layout") need the same work context, workspace and
history. Each autonomous invocation also needs its own status, steps and approvals.

## Decision

A `Thread` is the durable work context, tied to one conversation and one agent. An `AgentRun`
is one invocation within a thread. Runs follow a closed state machine defined once in
`packages/contracts/src/run-lifecycle.ts` and enforced by the control plane:

```text
QUEUED → RUNNING ⇄ WAITING_FOR_APPROVAL
QUEUED | RUNNING | WAITING_FOR_APPROVAL → CANCELLED
RUNNING → COMPLETED | FAILED
WAITING_FOR_APPROVAL → QUEUED   (approval decided; resume pending runtime pickup)
```

Events are append-only with a per-run monotonic sequence. A paused run resumes after an
approval decision without restarting.

## Consequences

- A thread allows only one active (non-terminal) run at a time, which prevents concurrent edits
  of a shared workspace.
- Terminal runs are immutable; a retry creates a new run in the same thread.
