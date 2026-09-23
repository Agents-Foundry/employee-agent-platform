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
  control-plane-api/   Express API and central SQLite development store
  control-plane-web/   Angular admin control plane
  employee-desktop/    Angular employee UI plus Tauri shell
packages/
  contracts/           Shared API and domain contracts
  policy-engine/       Fail-closed governed-action decisions
docs/
  adr/                  Architecture decision records
```

SQLite is the zero-dependency development persistence layer. Its repository boundary is intentionally isolated so production can move to managed PostgreSQL without changing the API contract.

## Local development

Prerequisites: Node.js 24 LTS, npm 11, and (for the native desktop build) the Rust toolchain plus Tauri system dependencies.

```bash
npm install
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

No raw provider key is stored. A future vault integration stores secrets and provides only opaque secret references to the control plane.

## Current milestone boundary

Foundation Milestone 1 intentionally stops before live Jira/Bitbucket connectors, LLM calls, and Playwright execution. Those integrations will be added behind the existing policy and approval contracts so no external write or browser run can bypass governance.

See [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and the [security model](docs/security.md).

See [provisioning design](docs/provisioning.md) for API routes, signing-key persistence, and the local-demo trust boundary.

Password-mode organization administrators can now manage nested departments/teams, employee
memberships, job families, disciplines, job roles, levels and positions. See the
[DIY organization implementation ledger](docs/diy-organization-platform.md) for migrations,
security boundaries, verification and the remaining phased implementation. This is not yet the
complete DIY bootstrap/setup-wizard platform.
