# Delivery roadmap

## Milestone 1 — Foundation (implemented)

- Admin and employee application shells
- Central conversation API and persistence
- QA agent catalog entry and shared contracts
- Hybrid key-mode policy model
- Policy decisions, approval workflow, and audit events
- Build/test CI

## Milestone 2 — Identity and production data

- Organization SSO/OIDC and verified RBAC
- Managed PostgreSQL migration and row-level organization isolation
- Vault-backed BYOK and organization-key bindings
- Admin CRUD for departments, teams, roles, employees, and agents

## Milestone 3 — Read-only QA context

- Jira story and release context
- Bitbucket repository indexing and change-impact analysis
- Approved connector registry, bounded retries, and audit evidence

## Milestone 4 — Isolated test execution

- Ephemeral execution job per approved run
- Playwright trace, screenshots, console, and network evidence
- Artifact retention policy and signed downloads
- Pre/post-release sanity packs

## Milestone 5 — Governed writes and pilot

- Evidence-backed Jira defect drafts
- Human-approved Jira/PR writes
- Evaluation suite, failure drills, observability, and QA team pilot

## Milestone 6 — Agent factory

- Reusable role blueprints for frontend, backend, DevOps, product, sales, and HR
- Versioned skills, tools, connectors, policies, evaluations, and promotion workflow
