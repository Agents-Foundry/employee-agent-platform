# ADR 0036: Failure drills, and reconciliation of writes with an unknown outcome

- Status: Accepted
- Date: 2026-10-02

## Context

ADR 0032 made a run survive the loss of its runtime. A pilot also needs to know what happens
when anything else stops at a bad moment: the control plane in the middle of a connector call,
the execution runtime in the middle of an operation, the secret store, the artifact store, the
database, the egress proxy, or the external system itself.

Writing the drills found four defects:

1. **A write whose connector call failed ambiguously was recorded as a plain failure.** A
   timeout, a dropped connection or a server error after the request was sent does not mean
   the external system did nothing. The model saw an error and could ask again; the Action
   Gateway would have decided and dispatched the second request, creating the issue twice.
2. **A dispatch interrupted by a control-plane stop stayed `DISPATCHING` for ever.** The run's
   runtime was answered `ACTION_EXECUTION_IN_PROGRESS` on every attempt and never learned an
   outcome.
3. **A database connection lost during a query ended the control-plane process.** The pool
   handled errors on idle connections only; a connection in use emitted an unhandled `error`.
4. **A grant an execution runtime was working under when it stopped stayed in use for ever**
   (`GRANT_IN_USE`), unless it was a credentialed checkout.

## Decision

### Every failure has one of five named outcomes

| Outcome               | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| Safe retry            | The same request is repeated; its identifier makes the repeat harmless.             |
| Recovery              | Another process continues from durable state.                                       |
| Idempotent reuse      | A repeat is answered from the recorded result; the work is not done again.          |
| Fail closed           | The step or the run fails; nothing is done that could not be authorized or checked. |
| Manual reconciliation | The outcome is unknown; the write is blocked until a person has checked.            |

No drill may perform a governed external write twice.

### Writes whose outcome is unknown

- Each control-plane action is a `read` or a `write`.
- A connector reports `CONNECTOR_OUTCOME_UNKNOWN` for a write when there was no response, when
  the provider answered with a server error, or when it accepted the request and its answer
  could not be read. A refusal (4xx) stays `CONNECTOR_REQUEST_FAILED` and is final. For a pull
  request, once the branch has been created any later failure is unknown: the change is
  part-published.
- The execution is recorded as failed with that code, and a row in
  `agent_action_reconciliations` (migration 0015) says a person must check, with state
  `REQUIRED`.
- While it is `REQUIRED`, the Action Gateway denies (`ACTION_RECONCILIATION_REQUIRED`) any
  write of the same action **for that thread**, and any write of the same action **with the
  same payload anywhere in the organization**. A reworded retry by the model, a new run in the
  thread and a second run with the same payload are all refused, at decision time and again
  at execution time.
- An administrator of the organization lists reconciliations and resolves each one, once
  (`/api/organization/action-reconciliations`): `APPLIED`, or `NOT_APPLIED`, after which the
  action may be requested again. Rows are never changed afterwards or removed.
- The model is told plainly that the action may or may not have happened and must not be
  repeated.

### Interrupted dispatches

A dispatch with no recorded outcome after longer than any dispatch can run (the connector
timeout plus thirty seconds) was interrupted. It is closed as `DISPATCH_INTERRUPTED`: when
its runtime asks again, and by a sweep every minute. For a write this requires reconciliation
exactly as above; a read is simply failed. A late answer from the old process changes nothing
that was recorded.

### Lost database connections

- A connection in use that is lost fails its query and nothing else.
- A transaction that lost its connection before `COMMIT` was sent is run again, up to four
  times over about three seconds. Nothing of it was kept, and transactions were already
  written to be re-run for serialization failures.
- A connection lost while `COMMIT` was in flight is never retried by the store: the outcome is
  unknown, and the caller's own idempotency (event, request and reservation identifiers)
  decides.

### Agent runtime retries

Action decisions, executions and grants are keyed by their request identifier, so the runtime
repeats them when the control plane is unreachable or answers with a server error. A refusal
is final. `ACTION_EXECUTION_IN_PROGRESS` is waited for, never treated as a reason to ask for a
new action.

### Execution runtime restarts

At startup an execution runtime closes every grant the previous process was working under
with `OPERATION_INTERRUPTED`, so a repeat of the request is told what happened. A grant under
which nothing had started stays usable. Credentialed checkouts are additionally discarded and
their leases released (ADR 0031).

## The drills

`apps/control-plane-api/test/failure-drills.spec.ts` and
`apps/execution-runtime/test/failure-drills.spec.ts` run real runtimes against a real control
plane and database.

| #   | Failure                                                          | Outcome                                   |
| --- | ---------------------------------------------------------------- | ----------------------------------------- |
| 1   | Agent runtime dies during a model call                           | Recovery; the reservation stays counted   |
| 2   | Runtime dies immediately before a tool                           | Recovery; the tool runs once              |
| 3   | Runtime dies after a governed connector action succeeded         | Idempotent reuse                          |
| 4   | Runtime dies after an execution operation, before its checkpoint | Idempotent reuse of the grant's result    |
| 5   | Runtime dies during an artifact upload                           | Recovery; retention removes the orphan    |
| 6a  | Control plane restarts while a run is active                     | Recovery                                  |
| 6b  | Control plane dies while dispatching a write                     | Manual reconciliation                     |
| 7   | Execution runtime restarts during an operation or checkout       | Fail closed; lease released; grant closed |
| 8   | Secret store unavailable                                         | Fail closed; a later run succeeds         |
| 9   | Artifact store unavailable                                       | Safe retry; retrieval refused meanwhile   |
| 10  | Database connections lost                                        | Safe retry                                |
| 11  | Egress proxy fails to start, or cannot be configured             | Fail closed; the sandbox never starts     |
| 12  | Connector times out after the remote system may have accepted    | Manual reconciliation                     |

## Consequences

- An unknown outcome stops further writes of that action in the thread until a person acts.
  That is deliberate: the alternative is a duplicate.
- Reconciliation has an API and no screen. An operator should alert on
  `af_action_reconciliations_total{event="required"}`.
- A provider that offers idempotency keys could turn drill 12 into a safe retry. Jira's issue
  API does not; the connector contract can add this per provider later.
- Recovery after a lost runtime still waits for the lease to expire, up to ten minutes.
