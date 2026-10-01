# Agents Foundry

Agents Foundry is a governed AI employee platform for SaaS and engineering organizations. The first proof of concept is **Engineering → QA Engineer**.

This clean-slate repository implements the first end-to-end control boundary:

- an Angular admin control plane for agents, policy, keys, and approvals;
- an Angular employee workspace packaged as a Tauri 2 desktop application;
- a Node/Express control-plane API with centrally persisted conversations;
- an explicit policy engine that gates external writes and browser execution;
- hybrid model-key metadata for employee BYOK and organization-managed keys;
- an append-only application audit stream.
- versioned QA onboarding, admin provisioning decisions, and Ed25519-signed agent manifests.

## Locked product decisions

| Decision              | Foundation implementation                   |
| --------------------- | ------------------------------------------- |
| Admin experience      | SaaS control plane                          |
| Employee experience   | Rust/Tauri desktop shell with Angular UI    |
| Conversations         | Synced through the central API and database |
| Model credentials     | Employee BYOK and organization-managed keys |
| First POC             | Engineering / QA Engineer                   |
| High-impact actions   | Human approval required                     |
| Production deployment | Denied to the QA employee agent             |

## Repository layout

```text
apps/
  control-plane-api/   Express API on PostgreSQL with row-level security
  control-plane-web/   Angular admin control plane
  employee-desktop/    Angular employee UI plus Tauri shell
  agent-runtime/       Separate agent runtime process (kernel, model gateway, tools)
  execution-runtime/   Separate execution process (workspaces, git, Playwright) behind grants
packages/
  contracts/           Shared API and domain contracts
  policy-engine/       Fail-closed governed-action decisions
docs/
  adr/                  Architecture decision records
```

The control plane stores its data in PostgreSQL. Every tenant table is isolated by forced row-level security, with separate database roles for tenant work, cross-tenant sign-in and migrations ([ADR 0018](docs/adr/0018-postgresql-row-level-security.md)).

## Local development

Prerequisites: Node.js 24 LTS, npm 11, Docker (for a local PostgreSQL, and for the tests), and (for the native desktop build) the Rust toolchain plus Tauri system dependencies.

```bash
npm install
cp .env.example .env        # local PostgreSQL URLs with development-only passwords
npm run db:dev              # PostgreSQL 16 in Docker on 127.0.0.1:55433
npm run db:bootstrap        # database and roles; the API applies migrations at startup
npm run dev:api:demo
npm run start:admin
npm run start:employee
```

- API: `http://localhost:4100/api/health`
- Admin control plane: `http://localhost:4200`
- Employee web preview: `http://localhost:4300`

For Google Workspace sign-in, follow [the Google setup guide](docs/google-workspace.md) and use `npm run dev:api`. Google mode is the server default and requires explicit OAuth and membership configuration. The demo command is an intentional local-only opt-in.

Run every build and test gate:

```bash
npm run check
```

The control-plane tests start a throwaway PostgreSQL container, or use `TEST_DATABASE_ADMIN_URL` (a superuser URL) when set, as CI does. An existing SQLite database can be imported into an empty PostgreSQL database with `npm run db:import-sqlite -- <path>`.

## QA POC flow

### Provision an employee agent

1. In the employee app, expand **Request your QA agent** and complete the blueprint questionnaire and model preferences.
2. Submit the request, then review its answers and fixed permissions in the admin app's **Agent provisioning** panel.
3. Enter a reason and approve or reject it. Approval atomically creates an assigned agent, immutable signed manifest, and lifecycle audit events.
4. Refresh requests in the employee app and select **Verify and use agent**. Signature and ownership verification must succeed before selection changes. New QA tasks then use this agent. Existing conversations keep their original agent.

The seeded demo agent remains available for the original QA flow. Model preferences are metadata; neither credentials nor model execution are enabled by provisioning.

### Request a QA plan

1. The employee starts a QA task using a Jira-style story key and target environment.
2. The central API persists the conversation and request.
3. The QA agent creates an evidence-oriented test plan.
4. Policy evaluation marks Playwright execution as `REQUIRE_APPROVAL`.
5. An admin approves or rejects the request in the control plane.
6. Approval changes the run to `READY`; actual isolated execution is the next milestone.

Each QA request is also recorded as a role-independent generic run (thread, run, steps and
append-only events), readable through `/api/execution/v1`. Approval re-queues that run for a
future runtime and rejection cancels it. See [Architecture V2](docs/architecture-v2.md).

No raw provider key is stored. A future vault integration stores secrets and provides only opaque secret references to the control plane.

## Current milestone boundary

Foundation Milestone 1 intentionally stops before live Jira/Bitbucket connectors, LLM calls, and Playwright execution. Those integrations will be added behind the existing policy and approval contracts so no external write or browser run can bypass governance.

See [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and the [security model](docs/security.md).

## Architecture V2 (in progress)

Agents Foundry is evolving into a governed platform for many AI employee roles, with the control
plane, agent runtime, execution runtime and declarative role packages kept separate. Phase A
(generic execution contracts, the thread/run/step/event model, artifacts, Agent Manifest v2 and
the `agents-foundry/runtime/v1` protocol), Phase B (a versioned, digest-pinned agent catalog
with organization installations), Phase C (a separate agent runtime process with a kernel,
model gateway, signed transport and approval pause/resume) and Phase D (the Action Gateway:
Policy v2, expiring payload-bound approvals, single-use connector execution and Jira issue
creation), Phase E (a separate execution runtime that runs git and Playwright only under
control-plane-signed, single-use grants) and Phase F (QA stories run end to end on the
generic runtime behind `QA_GENERIC_RUNTIME_ENABLED`) and Phase G (a Frontend Engineer role
package running on the same runtimes, governed file writes, project scripts and draft pull
requests, and a container sandbox) are implemented. Generic runs are
off by default (`GENERIC_AGENT_RUNTIME_ENABLED`).

- [Architecture V2](docs/architecture-v2.md) and the [gap analysis](docs/architecture-v2-gap-analysis.md)
- [Migration plan](docs/migration-plan.md), [runtime protocol](docs/runtime-protocol.md),
  [Agent Manifest v2](docs/agent-manifest-v2.md), [artifacts](docs/artifacts.md),
  [agent catalog](docs/agent-catalog.md)
- ADRs [0002](docs/adr/0002-separate-agent-runtime-from-control-plane.md) to
  [0015](docs/adr/0015-frontend-engineer-and-sandboxed-execution.md),
  [0016](docs/adr/0016-egress-proxy.md),
  [0017](docs/adr/0017-dependency-installation.md),
  [0018](docs/adr/0018-postgresql-row-level-security.md),
  [0019](docs/adr/0019-role-evaluation-suites.md),
  [0020](docs/adr/0020-model-quality-evaluations.md),
  [0021](docs/adr/0021-model-spending-limits.md),
  [0022](docs/adr/0022-model-prices-and-cost-limits.md),
  [0023](docs/adr/0023-model-budget-alerts.md),
  [0024](docs/adr/0024-alert-webhooks.md),
  [0025](docs/adr/0025-scheduled-quality-runs.md),
  [0026](docs/adr/0026-model-quality-view.md),
  [0027](docs/adr/0027-tenant-domain-cache.md),
  [0028](docs/adr/0028-native-column-types.md)
- Agent runtime (Phase C): [docs/agent-runtime.md](docs/agent-runtime.md)
- Action Gateway (Phase D): [docs/action-gateway.md](docs/action-gateway.md)
- Execution runtime (Phase E): [docs/execution-runtime.md](docs/execution-runtime.md)

See [provisioning design](docs/provisioning.md) for API routes, signing-key persistence, and the local-demo trust boundary.

Password-mode organization administrators can now manage nested departments/teams, employee
memberships, job families, disciplines, job roles, levels and positions. They can also edit
their profile, verify a domain, record employees before inviting them and assign positions.
Existing accounts can accept a private invitation into another organization and switch between
active memberships. See the
[DIY organization implementation ledger](docs/diy-organization-platform.md) for migrations,
security boundaries, verification and the remaining phased implementation. This is not yet the
complete DIY bootstrap/setup-wizard platform.
