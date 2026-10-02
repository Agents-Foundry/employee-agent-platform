# Failure handling and reconciliation

What the platform does when a component stops at a bad moment, and what an operator or an
administrator has to do. The decisions are in
[ADR 0036](adr/0036-failure-drills-and-reconciliation.md) and
[ADR 0032](adr/0032-durable-checkpoints-and-run-recovery.md).

## What happens by itself

| Failure                           | Result                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| An agent runtime stops            | After its lease expires (up to 10 minutes) another runtime continues the run from its checkpoint       |
| ... during a model call           | The call is made again; the lost call stays counted against the budget at what it reserved             |
| ... before or after a tool        | The tool runs once: a repeat is answered from the recorded decision, execution or grant                |
| ... during an artifact upload     | The artifact is stored again; the unregistered bytes are removed after a day                           |
| The control plane restarts        | Runs continue; runtimes repeat requests that are safe to repeat                                        |
| An execution runtime restarts     | Operations it was running are closed as `OPERATION_INTERRUPTED`; checkouts are discarded, leases ended |
| The secret store is unavailable   | Actions and model calls that need a secret are refused; nothing is called without it                   |
| The artifact store is unavailable | Uploads and downloads are refused (`ARTIFACT_STORE_UNAVAILABLE`) and can be repeated                   |
| The database drops connections    | Transactions are run again for about three seconds; after that the request fails and is retried        |
| The egress proxy cannot start     | The sandbox is never started (`EGRESS_PROXY_UNAVAILABLE`)                                              |

## What needs a person: reconciliation

When a connector does not confirm a **write** (no response, a server error, an answer that
cannot be read), or the control plane stopped while it was sending one, the external system
may or may not have applied it. The platform does not guess and does not send it again:

- the tool call fails with `CONNECTOR_OUTCOME_UNKNOWN` or `DISPATCH_INTERRUPTED`, and the
  agent is told not to repeat the action;
- further writes of that action are refused (`ACTION_RECONCILIATION_REQUIRED`) for that
  thread, and for that exact payload anywhere in the organization;
- an administrator checks the external system and records what they found.

```bash
# What is waiting (organization administrators, password mode)
GET  /api/organization/action-reconciliations

# The external system has it:
POST /api/organization/action-reconciliations/<requestId>/resolution
{ "resolution": "APPLIED", "note": "QA-512 exists" }

# It does not, so the action may be requested again:
POST /api/organization/action-reconciliations/<requestId>/resolution
{ "resolution": "NOT_APPLIED", "note": "No such issue in QA" }
```

A reconciliation is resolved once and is never changed or removed. Each one is audited
(`action.reconciliation.required`, `action.reconciliation.resolved`) and counted
(`af_action_reconciliations_total`).

## Proving it

The failure drills run in the normal test suites:

```bash
npx vitest run test/failure-drills.spec.ts   # in apps/control-plane-api
npx vitest run test/failure-drills.spec.ts   # in apps/execution-runtime
```

Each drill states which outcome it proves, and none may send a governed write twice.
