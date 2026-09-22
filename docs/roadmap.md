# Delivery roadmap

## Milestone 1 — Foundation (implemented)

- Admin and employee application shells
- Central conversation API and persistence
- QA agent catalog entry and shared contracts
- Hybrid key-mode policy model
- Policy decisions, approval workflow, and audit events
- Build/test CI
- Versioned QA questionnaire and employee provisioning requests
- Transactional admin decisions, persistent Ed25519 manifests, client verification, and lifecycle audit view

## Milestone 2 — Identity and production data

### Customer onboarding and organization administration (in progress)

- Password-only authentication independent of Google (implemented)
- Operator-created organizations and one-time first-admin activation (implemented)
- Admin employee invitations, member listing, and immediate access revocation (implemented)
- Invitation reissue and administrator-assisted password recovery (implemented)
- Email delivery, self-service recovery requests, and purchase automation (pending)
- Admin-created agents and employee assignments (pending)
- Per-organization optional SSO and expanded administration (pending)

See `customer-onboarding.md` for the first slice and its rollout limits.

- Google Workspace browser SSO/OIDC and verified RBAC (implemented; live tenant configuration required)
- Native system-browser Google sign-in (pending)
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
