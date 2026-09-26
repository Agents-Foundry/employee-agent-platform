# Architecture V2 migration plan

Incremental, no big-bang replacement. Each phase must leave `npm run check` green, keep the
legacy QA flow working, and keep every security control fail-closed. A phase is complete only
when it has a data model, business logic, authorization, integration, UI where relevant, tests,
error handling and documentation. A type, table or route stub alone does not count.

| Phase | Scope                                                                                                       | Status                  |
| ----- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| A     | Generic execution contracts, Thread/AgentRun/RunStep/AgentEvent, Artifact, Manifest v2, runtime protocol v1 | Implemented (see below) |
| B     | Catalog: `AgentBlueprintVersion`, skills, workflows, tool/connector requirements, org installations         | Implemented (see below) |
| C     | Agent runtime: session, run loop, model abstraction, one tool, approval pause/resume, signed transport      | Implemented (see below) |
| D     | Action Gateway: semantic actions, contextual policy bridge, approvals, audit, connector dispatch            | Implemented (see below) |
| E     | `execution-runtime`: workspaces, checkout, shell, filesystem, artifact capture, then browser/Playwright     | Implemented (see below) |
| F     | QA migration from the static six-step plan to the generic runtime (feature-flagged)                         | Not started             |
| G     | Frontend Engineer on the same runtime, as the architectural acceptance test                                 | Not started             |

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

## Phase C — delivered

- `apps/agent-runtime`: a separate workspace and process (ADR 0011). It contains:
  - `RuntimeHost`;
  - the `AgentKernel` boundary with `NativeKernel`;
  - `ModelGateway` with an Anthropic adapter, credential brokering and a scripted test
    provider;
  - `ToolRegistry` with the `artifact` tool;
  - file checkpoints and a local artifact store.
    See [agent-runtime.md](agent-runtime.md).
- Signed runtime transport `/runtime/v1` (commands/claim, events, actions) with Ed25519
  workload identity, single-use nonces and tenant and profile scope.
- Migration 008: `agent_run_leases`, `runtime_request_nonces` and `agent_action_requests`
  (append-only).
- Governed-action decisions: policy engine plus manifest plus pinned catalog tool. Approval
  creation and the run pause happen atomically. Resume validates the approval. `run.cancel`
  is delivered after a rejection or cancellation.
- Employee API: `POST /api/execution/v1/runs` (behind `GENERIC_AGENT_RUNTIME_ENABLED`) and
  `POST /api/execution/v1/runs/:id/cancel`.

### Phase C limitations

- Only `artifact` is a real tool. Governed tools need connectors (D) or the execution
  runtime (E). Pause and resume are proven with a test double.
- No employee UI for generic runs yet; runtime approvals appear in the existing admin panel.
- Resume is sticky to the runtime that holds the local checkpoint. There is no reaper yet for
  runs abandoned mid-execution.
- `EMPLOYEE_BYOK` agents cannot run on a server runtime (fail closed).

## Phase D — delivered

- Action Gateway (`apps/control-plane-api/src/actions`, [action-gateway.md](action-gateway.md),
  ADR 0012):
  - control-plane-executed actions with payload-bound, expiring approvals;
  - single-use execution;
  - re-authorization at execution time.
- Policy v2 (`evaluateActionPolicy`). Platform decision, manifest capability,
  organization overrides (tighten-only) and resource scope. Carries `policyId`,
  `policyVersion` and conditions.
- Connectors: `IssueTrackerConnector` with Jira Cloud. Organization connections hold
  `secret://` references resolved per tenant at dispatch (`CONNECTOR_SECRETS_PATH`).
- Runtime: the real `issue-tracker` tool replaces the Phase C test double.
  `POST /runtime/v1/actions/execute` was added, and action requests carry `parameters`.
- Catalog: QA Engineer 1.2.0 adds `issueTracker.write`. 1.1.0 is unchanged.
- Admin UI: the governed actions and connections panel. The approval queue shows resource and
  expiry.
- Migration 009.

### Phase D limitations

- One control-plane action (`jira.issue.create`) and one connector (Jira Cloud).
- There is no egress proxy or DNS-rebinding defence. Interrupted dispatches need manual
  reconciliation.
- Secrets come from an operator file, not a managed vault.

## Phase E — delivered

- `apps/execution-runtime`: a separate process and workspace ([execution-runtime.md](execution-runtime.md),
  ADR 0013). It contains:
  - grant verification against the pinned control-plane key;
  - single-use grants with idempotent replay;
  - per-thread workspaces with explicit `WORKSPACE_LOST`;
  - `LocalExecutionProvider`: git checkout and status, file read and Playwright, with path
    confinement, a scrubbed environment, argument lists, process-tree timeouts and output caps;
  - evidence stored as artifacts.
- Control plane: execution grants (`POST /runtime/v1/actions/grant`, migration 010). Execution
  actions require the exact operation as `parameters`. Checkout scope is the configured
  repository and Playwright scope the configured QA origin. Approvers see a summary the
  control plane writes.
- Agent runtime: `repository` and `browser` tools that obtain a grant, then call the
  execution runtime. They are offered only when `EXECUTION_RUNTIME_URL` is set.
- The Phase C/D test doubles for runtime-executed actions now send real operations.

### Phase E limitations

- There is no sandboxing provider. Sandboxed agents run only with
  `EXECUTION_ALLOW_UNSANDBOXED=true`.
- There is no dependency installation, and private repositories are not supported.
  `command` and `file.write` are never granted.

## Feature flags

| Flag                                 | Default | Effect                                                                                         |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `AGENT_MANIFEST_V2_ISSUANCE_ENABLED` | `false` | New agents receive `agents-foundry/v2` manifests                                               |
| `GENERIC_AGENT_RUNTIME_ENABLED`      | `false` | Employees may start generic runs (`POST /api/execution/v1/runs`)                               |
| `AGENT_RUNTIME_IDENTITIES_PATH`      | unset   | Runtime public keys and scopes; unset means no runtime can authenticate                        |
| `CONNECTOR_SECRETS_PATH`             | unset   | Per-organization connector secrets; unset means every governed write fails `SECRET_UNRESOLVED` |
| `EXECUTION_ALLOW_UNSANDBOXED`        | `false` | Execution runtime accepts sandboxed grants on the local provider (development only)            |

Flags never weaken security. Disabling a flag restores the previous behaviour; it never turns a
deny into an allow.

## Next recommended phase

Phase F: QA migration. Move the legacy `/api/qa/runs` static plan onto the generic runtime,
behind a feature flag:

- a validate-story workflow that checks out the repository, runs Playwright after approval and
  drafts defects through the Action Gateway;
- the employee app following run events instead of the legacy QA record.

In parallel, add a sandboxing `ExecutionProvider` (container with egress limited to the grant's
allow-list) so sandboxed agents no longer need `EXECUTION_ALLOW_UNSANDBOXED`.
