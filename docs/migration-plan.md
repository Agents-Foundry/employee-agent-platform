# Architecture V2 migration plan

Incremental, no big-bang replacement. Each phase must leave `npm run check` green, keep the
legacy QA flow working, and keep every security control fail-closed. A phase is complete only
when it has a data model, business logic, authorization, integration, UI where relevant, tests,
error handling and documentation. A type, table or route stub alone does not count.

| Phase | Scope                                                                                         | Status          |
| ----- | --------------------------------------------------------------------------------------------- | --------------- |
| A     | Generic execution contracts, Thread/AgentRun/RunStep/AgentEvent, Artifact, Manifest v2, runtime protocol v1 | Implemented (see below) |
| B     | Catalog: `AgentBlueprintVersion`, skills, workflows, tool/connector requirements, org installations | Not started     |
| C     | `agent-runtime` repository: session, run loop, model abstraction, one tool, approval pause/resume | Not started     |
| D     | Action Gateway: semantic actions, contextual policy bridge, approvals, audit, connector dispatch | Not started     |
| E     | `execution-runtime`: workspaces, checkout, shell, filesystem, artifact capture, then browser/Playwright | Not started |
| F     | QA migration from the static six-step plan to the generic runtime (feature-flagged)          | Not started     |
| G     | Frontend Engineer on the same runtime, as the architectural acceptance test                  | Not started     |

## Phase A — delivered

- Contracts: `packages/contracts/src/{execution,run-lifecycle,artifacts,manifest-v2}.ts` and
  `packages/contracts/src/runtime/v1/{protocol,schemas}.ts`.
- Persistence: migration 006 (`agent_threads`, `agent_runs`, `agent_run_steps`, `agent_events`,
  `agent_artifacts`, `approvals.run_id`/`step_id`).
- `ExecutionService`: tenant-scoped thread/run/step/event/artifact persistence, state-machine
  enforcement, runtime-event ingestion (service method only), approval-driven resume.
- QA compatibility: `/api/qa/runs` dual-writes a generic run in the same transaction; approval
  decisions resume (`QUEUED`) or cancel the linked run.
- Read API: `/api/execution/v1/threads/:id`, `/runs/:id`, `/runs/:id/events`.
- Manifest v2: issuance behind `AGENT_MANIFEST_V2_ISSUANCE_ENABLED`, with server and desktop
  verification of both versions.

### Phase A exit criteria not yet met by design

- No runtime executes runs. `QUEUED` after approval means "ready for a runtime", as `READY` does.
- No runtime-ingestion HTTP endpoint (it requires workload identity, Phase C).
- No UI for the run timeline yet. The employee app still shows the legacy QA result.

## Feature flags

| Flag                                  | Default | Effect                                                  |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `AGENT_MANIFEST_V2_ISSUANCE_ENABLED`  | `false` | New agents receive `agents-foundry/v2` manifests         |
| `GENERIC_AGENT_RUNTIME_ENABLED`       | —       | Reserved for Phase C/F; not read by code yet             |

Flags never weaken security. Disabling a flag restores the previous behaviour; it never turns a
deny into an allow.

## Next recommended phase

Phase B, followed immediately by a Phase C spike. The runtime protocol is only proven once a
real process speaks it. Phase B supplies the versioned catalog that Manifest v2 resolves from, and
removes the hard-coded QA adapter.
