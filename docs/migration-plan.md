# Architecture V2 migration plan

Incremental, no big-bang replacement. Each phase must leave `npm run check` green, keep the
legacy QA flow working, and keep every security control fail-closed. A phase is complete only
when it has a data model, business logic, authorization, integration, UI where relevant, tests,
error handling and documentation. A type, table or route stub alone does not count.

| Phase | Scope                                                                                         | Status          |
| ----- | --------------------------------------------------------------------------------------------- | --------------- |
| A     | Generic execution contracts, Thread/AgentRun/RunStep/AgentEvent, Artifact, Manifest v2, runtime protocol v1 | Implemented (see below) |
| B     | Catalog: `AgentBlueprintVersion`, skills, workflows, tool/connector requirements, org installations | Implemented (see below) |
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

## Phase B — delivered

- Declarative catalog package (`packages/catalog`): QA Engineer 1.1.0 plus four skills, four
  tools and four workflows. Strict schemas live in `packages/contracts/src/catalog-schemas.ts`.
- Startup validation of cross-references and policy actions. Migration 007 registers an
  immutable catalog of record pinned by digest (ADR 0010).
- Organization installations (migration 007, `InstallationService`, admin API and panel).
  Admin agent creation can start from an installation. `agents.installation_id` is set and
  enforced by a trigger.
- The generic manifest resolver replaces the Phase A QA adapter. `qaBlueprint` and
  `blueprints.ts` are removed; `/api/blueprints` is served from the catalog in its legacy shape.
- Provisioning and admin creation accept any registered blueprint version.

### Phase B limitations

- Role packages are built in. Loading them from external repositories, and a
  publish/promotion workflow, are future work.
- Installation editing is API-only in the UI. Existing agents cannot be moved to a new
  installation or blueprint version; create new agents instead.
- The employee provisioning request form still uses the latest blueprint and full
  questionnaire; it does not select installations.

## Feature flags

| Flag                                  | Default | Effect                                                  |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `AGENT_MANIFEST_V2_ISSUANCE_ENABLED`  | `false` | New agents receive `agents-foundry/v2` manifests         |
| `GENERIC_AGENT_RUNTIME_ENABLED`       | —       | Reserved for Phase C/F; not read by code yet             |

Flags never weaken security. Disabling a flag restores the previous behaviour; it never turns a
deny into an allow.

## Next recommended phase

Phase C: create the `agent-runtime` repository with an `AgentKernel` boundary, a model gateway
and one tool. Add an authenticated runtime transport that submits queued runs and ingests
`runtime/v1` events through the existing service. The runtime should consume v2 manifests,
because they now carry pinned skills, tools and workflows.
