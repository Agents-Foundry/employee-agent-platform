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
| F     | QA migration from the static six-step plan to the generic runtime (feature-flagged)                         | Implemented (see below) |
| G     | Frontend Engineer on the same runtime, as the architectural acceptance test                                 | Implemented (see below) |

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

## Phase F — delivered

- `QA_GENERIC_RUNTIME_ENABLED`: `POST /api/qa/runs` queues a `validate-story` run on the
  generic runtime for agents whose v2 manifest pins that workflow (`mode: GENERIC_RUNTIME`).
  Everything else keeps the legacy static plan (`mode: LEGACY_STATIC_PLAN`). Targets outside
  the configured QA origin are refused (`TARGET_OUT_OF_SCOPE`). See
  [ADR 0014](adr/0014-qa-on-the-generic-runtime.md).
- `run.submit` carries the task's `workflow`, resolved from the pinned catalog bundle. Runs
  naming an ungranted workflow are cancelled (`MANIFEST_INVALID`). The native kernel renders
  any workflow as numbered guidance, with no role-specific code.
- `jira.read`: a governed, allow-by-default control-plane action that reads one work item in
  an allowed project. The audit trail keeps only the key. The `issue-tracker` tool reads or
  files, and fences work-item text as data.
- Conversation threads: one thread per conversation, at most one active run, and a persistent
  workspace. Approvals and outcomes are mirrored into the conversation.
- Employee app: follows generic runs (status, steps, pending approvals, evidence, cancel).
- End-to-end test (`qa-generic-runtime.spec.ts`) across the control plane, agent runtime,
  execution runtime and a fake Jira: read story → checkout → Playwright (approved) → file
  defect (approved) → report.

### Phase F limitations

- The workflow is guidance to the model; step order is not enforced by policy.
- Real execution still needs `EXECUTION_ALLOW_UNSANDBOXED=true`: there is no sandboxing
  provider yet.
- The employee app polls run state every 2 seconds; there is no push channel.
- Legacy QA records (`qa_runs`) are kept and are still written when the flag is off.

## Phase G — delivered

- Frontend Engineer 1.0.0 as catalog data only: the `implement-ui-change` workflow, four
  skills, and the `code-editor`, `build` and `source-control` tools. A test scans the runtimes
  and gateway for role names ([ADR 0015](adr/0015-frontend-engineer-and-sandboxed-execution.md)).
- Governed workspace writes (`repository.write`) and project scripts (`workspace.command`:
  `npm run <configured script>`, network `NONE`).
- `repository.pull_request.create` through a GitHub connector: a control-plane-assembled,
  digest-bound change set and a draft pull request created through the API. Migration 011
  adds GitHub connections and stored change sets.
- `ContainerExecutionProvider`: repository code runs only in locked-down containers under the
  grant's CPU, memory, process and network limits. Tests run real containers when Docker is
  available.
- Admin: GitHub connections and a role selector. Employee app: a role selector, and generic
  runs for agents without the QA workflow. `POST /api/execution/v1/runs` accepts a
  `conversationId`.
- Acceptance test: the Frontend Engineer implements, verifies (in a container) and proposes a
  change on the shared runtime, publishing exactly the approved files.

### Phase G limitations

- No egress allow-list: container grants that need network are refused unless the operator
  accepts unrestricted egress (QA Playwright runs, for now). Resolved by the egress proxy
  ([ADR 0016](adr/0016-egress-proxy.md)).
- No dependency installation; scripts run offline. Resolved by governed installs
  ([ADR 0017](adr/0017-dependency-installation.md)).
- Pull requests are GitHub-only, and each change set is limited to 100 files and 1 MiB.
- Git and file operations run on the host, confined but not network-isolated.

## PostgreSQL with row-level security — delivered

See [ADR 0018](adr/0018-postgresql-row-level-security.md).

- The control plane runs on PostgreSQL. Every service, route and CLI is async, and each unit of
  work is one SERIALIZABLE transaction, retried on conflicts.
- Every tenant table (37, plus `organizations`) forces row-level security keyed on
  `app.organization_id`, set per transaction.
- Separate roles:
  - tenant work runs as a role that cannot bypass row-level security;
  - sign-in, sessions, invitations and runtime claims run in an explicit platform scope;
  - migrations run as the schema owner.
- The tenant role is never granted password hashes, session or invitation tokens, login
  state, runtime nonces or migration history.
- `npm run db:dev`, `db:bootstrap`, `db:migrate` and `db:import-sqlite`. The importer copies an
  existing SQLite database into an empty PostgreSQL database in one verified transaction.
- Tests clone a migrated template database per test. A database-level suite checks
  isolation in every tenant table, the role privileges, scope misuse, migration tampering and
  concurrent approval decisions.

### Limitations

- The platform role bypasses row-level security. Its flows keep explicit organization filters.
- Unique constraints are global, so they can reveal that a value (for example, an email
  address) exists in another tenant.
- Verified tenant domains are looked up per request, without a cache.
- The catalog is loaded at startup. A version registered later by another instance fails
  closed until restart.
- Timestamps and JSON stay text columns.

## Roles as catalog data, with evaluation suites — delivered

See [ADR 0019](adr/0019-role-evaluation-suites.md).

- Evaluation suites are catalog data, and every role version must name one for its role.
- A generic runner plays each scenario through the real control plane, agent runtime and
  execution runtime with a scripted model. It checks each tool result, each approval, the
  offered tools, the final run and the external actions that executed.
- Three new roles, as data only:
  - Backend Engineer 1.0.0;
  - Code Reviewer 1.0.0, least privilege: no editing or source-control tools, no writes;
  - Test Automation Engineer 1.0.0.
- 14 scenarios cover all seven role versions: approvals granted and rejected, scope limits,
  unavailable tools, and version differences. `npm run test:evals` runs them alone.

### Limitations

- They evaluate governance and role wiring, not model quality.
- Commands, installs and browser runs are recorded, not executed.
- The runner simulates Jira and GitHub only.

## Model-quality evaluations — delivered

See [ADR 0020](adr/0020-model-quality-evaluations.md).

- Quality tasks are catalog data: answers, a task, approved actions, simulated command and
  browser results, a budget, weighted checks (required ones are gates), a rubric and a pass
  threshold. Every role has one.
- A generic runner lets a real model work each task through the real platform, then grades
  it with deterministic checks and a grader model. Invalid or missing grades score zero.
- Cost controls: per-task turn and token limits, one token ledger for the whole run with no
  default, output capped at what remains, and a cost estimate from operator prices.
- `npm run eval:quality` runs live and writes reports; offline tests cover the runner with
  scripted models in `npm run check`.

### Limitations

- No live run is part of CI. Results depend on the model and the grader, and vary between runs.
- Commands, installs and browser runs are simulated.
- Budgets are per evaluation run, not per organization.

## Organization model spending limits — delivered

See [ADR 0021](adr/0021-model-spending-limits.md).

- Migration 0002 adds `organization_model_budgets` and `model_usage_reservations`, with
  row-level security. Usage rows allow one settlement and are never deleted.
- Organizations set an optional monthly and per-run token limit. Admins manage them in the
  console and through `/api/organization/model-budget`, and read usage by agent and model
  from `/api/organization/model-usage`.
- The runtime host reserves every model call with the control plane
  (`POST /runtime/v1/models/reserve`) and settles the reported usage
  (`POST /runtime/v1/models/settle`). Reservations are decided under a per-organization
  lock, and unsettled reservations count in full.
- Denied or unverifiable reservations make no model call and fail the run.

### Limitations

- Limits are in tokens, across all models alike; no prices or per-model limits.
- Input tokens are estimated before the call, so one call can overshoot by its estimate
  error, which errs high.
- A limit takes effect at a run's next model turn, not mid-call.

## Per-model prices and cost limits — delivered

See [ADR 0022](adr/0022-model-prices-and-cost-limits.md).

- Migration 0003 adds the append-only `model_prices` table, with row-level security. It adds
  a currency and monthly and per-run cost limits to `organization_model_budgets`, and the
  price and cost of each call to `model_usage_reservations`.
- Admins set a price per million input and output tokens for each model, in the
  organization's currency, through the console and `/api/organization/model-prices`.
- Each call is costed at the price it was reserved under. The tightest limit, in tokens or
  cost, decides how much output a call gets.
- With a cost limit set, a model without a price is refused and audited.
- The runtime protocol is unchanged.

### Limitations

- Cost follows the organization's own prices, not provider bills. Discounts, cached input and
  taxes are not modelled.
- The currency is fixed once the first price is set.
- A denial for a missing price uses the `MODEL_BUDGET_EXCEEDED` code, with its own reason.

## Feature flags

| Flag                                  | Default | Effect                                                                                         |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `AGENT_MANIFEST_V2_ISSUANCE_ENABLED`  | `false` | New agents receive `agents-foundry/v2` manifests                                               |
| `GENERIC_AGENT_RUNTIME_ENABLED`       | `false` | Employees may start generic runs (`POST /api/execution/v1/runs`)                               |
| `AGENT_RUNTIME_IDENTITIES_PATH`       | unset   | Runtime public keys and scopes; unset means no runtime can authenticate                        |
| `CONNECTOR_SECRETS_PATH`              | unset   | Per-organization connector secrets; unset means every governed write fails `SECRET_UNRESOLVED` |
| `EXECUTION_ALLOW_UNSANDBOXED`         | `false` | Execution runtime accepts sandboxed grants on the local provider (development only)            |
| `QA_GENERIC_RUNTIME_ENABLED`          | `false` | `/api/qa/runs` queues generic `validate-story` runs for eligible agents                        |
| `EXECUTION_PROVIDER`                  | `local` | `container` runs repository code in locked-down containers (sandboxed isolation)               |
| `EXECUTION_EGRESS_PROXY`              | `true`  | Container provider enforces grant host allow-lists through a per-operation egress proxy        |
| `EXECUTION_ALLOW_UNRESTRICTED_EGRESS` | `false` | Without the proxy: network-needing grants run with no allow-list (development only)            |

Flags never weaken security. Disabling a flag restores the previous behaviour; it never turns a
deny into an allow.

## Next recommended phase

All planned phases (A–G) are delivered. Since then, grant host allow-lists are enforced by an
egress proxy ([ADR 0016](adr/0016-egress-proxy.md)), and Frontend Engineer 1.1.0 installs
locked dependencies from its configured registry
([ADR 0017](adr/0017-dependency-installation.md)). An opt-in check runs real Chromium behind
the proxy, and Playwright grants allow 256 processes, because Chromium crashes under 64. The
control plane now runs on PostgreSQL with row-level security
([ADR 0018](adr/0018-postgresql-row-level-security.md)), and roles ship with governance
evaluation suites ([ADR 0019](adr/0019-role-evaluation-suites.md)) and model-quality
tasks ([ADR 0020](adr/0020-model-quality-evaluations.md)). Organizations limit model token
use per month and per run ([ADR 0021](adr/0021-model-spending-limits.md)), and cost at their
own per-model prices ([ADR 0022](adr/0022-model-prices-and-cost-limits.md)). The
highest-value follow-ups are:

- alerts to administrators before a token or cost limit is reached;
- a scheduled live quality run that tracks scores per model over time;
- caching verified tenant domains, which each request now looks up in the database;
- native timestamp and JSON column types, which stay text for now so digests and ordering do
  not change.
