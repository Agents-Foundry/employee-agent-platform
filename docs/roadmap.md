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
- Admin-created QA agents and employee-bound assignments with signed manifests (implemented)
- Per-organization optional SSO and expanded administration (pending)

See `customer-onboarding.md` for the first slice and its rollout limits.

- Google Workspace browser SSO/OIDC and verified RBAC (implemented; live tenant configuration required)
- Native system-browser Google sign-in (pending)
- PostgreSQL with row-level organization isolation (implemented, [ADR 0018](adr/0018-postgresql-row-level-security.md))
- Organization model-key bindings resolved through the secret broker (implemented,
  [ADR 0034](adr/0034-organization-managed-model-credentials.md)); employee BYOK on a
  desktop-local runtime (pending, designed in the same ADR)
- Admin CRUD for departments, teams, roles, employees, and agents

## Milestone 3 — Read-only QA context

- Jira story context (implemented: governed `jira.read`, Architecture V2 Phase F); release
  context (pending)
- Bitbucket repository indexing and change-impact analysis (pending)
- Approved connector registry, bounded retries, and audit evidence (partly implemented:
  per-organization Jira and GitHub connections behind the Action Gateway, with audit)

## Milestone 4 — Isolated test execution

- Isolated execution per approved operation (implemented: the separate execution runtime runs
  each operation under a signed, single-use grant; repository code runs in locked-down
  containers behind an egress proxy)
- Playwright runs captured as artifacts (implemented); trace, screenshot, console and network
  evidence beyond the run output (pending)
- Durable artifact storage, retention enforcement and short-lived authorized downloads
  (implemented, [ADR 0033](adr/0033-durable-artifact-storage.md))
- Pre/post-release sanity packs (pending)

## Milestone 5 — Governed writes and pilot

- Human-approved Jira issue creation and draft GitHub pull requests (implemented, Phases D
  and G)
- Governance evaluation suites and model-quality evaluations (implemented, ADRs 0019, 0020 and 0025)
- Failure drills, observability and the QA team pilot (pending)

## Architecture V2 track

Phased evolution toward a generic governed AI employee platform. See `migration-plan.md`.

All planned phases are implemented:

- Phase A — generic execution contracts, thread/run/step/event persistence, artifacts, Agent
  Manifest v2 (flagged) and the runtime protocol v1
- Phase B — versioned, digest-pinned agent catalog and organization installations
- Phase C — separate agent runtime with signed transport, workload identity and approval
  pause/resume
- Phase D — Action Gateway, Policy v2, payload-bound approvals and Jira issue creation
- Phase E — separate execution runtime under signed, single-use execution grants
- Phase F — QA stories on the generic runtime (behind `QA_GENERIC_RUNTIME_ENABLED`)
- Phase G — Frontend Engineer as the second-role acceptance test, with container sandboxing

Hardening delivered since: egress proxy, governed dependency installation, PostgreSQL with
forced row-level security, role evaluation suites, model-quality evaluations, organization
model spending limits, prices and alerts, signed alert webhooks, scheduled quality runs,
per-instance tenant domain cache, native column types and multi-instance catalog reload
(ADRs 0016–0029).

Secrets are read through a broker with a Vault provider, and private GitHub and Bitbucket
repositories are checked out with single-use credential leases (ADR 0031).

Runs are recoverable: checkpoints are durable, leases are kept alive by heartbeats, and another
runtime continues an abandoned run (ADR 0032). Artifacts are stored durably with enforced
retention (ADR 0033), and organization model keys come from the secret broker (ADR 0034).

## Milestone 6 — Agent factory

- Reusable role blueprints as catalog data: QA Engineer, Frontend Engineer, Backend Engineer,
  Code Reviewer and Test Automation Engineer (implemented); DevOps, product, sales and HR
  (pending)
- Versioned skills, tools, policies and evaluations as catalog data (implemented); a catalog
  promotion workflow (pending)
