# Agents Foundry

Agents Foundry is a governed AI employee platform for SaaS and engineering organizations. The first proof of concept is **Engineering → QA Engineer**.

This clean-slate repository implements the first end-to-end control boundary:

- an Angular admin control plane for agents, policy, keys, and approvals;
- an Angular employee workspace packaged as a Tauri 2 desktop application;
- a Node/Express control-plane API with centrally persisted conversations;
- an explicit policy engine that gates external writes and browser execution;
- hybrid model-key metadata for employee BYOK and organization-managed keys;
- an append-only application audit stream.

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
npm run dev:api
npm run start:admin
npm run start:employee
```

- API: `http://localhost:4100/api/health`
- Admin control plane: `http://localhost:4200`
- Employee web preview: `http://localhost:4300`

Run every build and test gate:

```bash
npm run check
```

## QA POC flow

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
