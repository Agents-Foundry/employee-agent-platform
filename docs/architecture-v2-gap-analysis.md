# Architecture V2 — repository-grounded gap analysis

- Status: Accepted as the Phase A baseline
- Date: 2026-09-23
- Scope: `Agents-Foundry/employee-agent-platform` at `a304bef` (main)

This document compares the Architecture V2 brief (governed AI employee platform: control
plane + agent runtime + execution runtime + declarative role packages) against the code that
actually exists. Every statement about "current" behaviour is derived from the files named.
Nothing listed as a gap is implemented by a type, table or placeholder alone.

## 1. Current architecture

```text
apps/control-plane-web   Angular 22 admin SPA (organization, people, jobs, agents, approvals)
apps/employee-desktop    Angular 22 employee SPA + Tauri 2 shell (Rust shell is a bare default builder)
apps/control-plane-api   Express 5 + node:sqlite, single process, synchronous DatabaseSync
packages/contracts       Pure TypeScript domain/API interfaces + canonical JSON for signing
packages/policy-engine   Static action → decision table, fail-closed for unknown actions
packages/web-auth        Shared Angular auth panel, session handling, account switcher
```

Only `apps/control-plane-api` is an npm workspace. `packages/*` are consumed through
TypeScript path mappings (`tsconfig.json`) and relative imports; they have no build step or
package manifest. Runtime dependencies such as `zod` are hoisted to the root `node_modules`.

Request path for the only "agent execution" that exists today (`apps/control-plane-api/src/app.ts`):

```text
POST /api/qa/runs
  → zod validation (story key, HTTP(S) target)
  → conversation ownership + signed manifest verification (database.getManifest)
  → evaluatePolicy('qa.execute_playwright') must be REQUIRE_APPROVAL
  → fixed six-string plan (hard-coded in app.ts)
  → transaction: approvals row + qa_runs row + audit_events row
  → AGENT message appended to the conversation
POST /api/approvals/:id/decision (admin, not self)
  → approvals.status + qa_runs.status = READY | REJECTED + audit
```

Nothing consumes a `READY` run. There is no LLM call, no tool call, no Playwright, no
connector, no workspace, and no artifact.

## 2. Current implemented capabilities (preserve)

| Area                         | Evidence                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Tenancy and org structure    | `migrations/001`–`005`, `organization/structure-service.ts`, `tenancy-service.ts`                 |
| Job architecture             | `organization/job-service.ts`, `packages/contracts/src/jobs.ts`                                   |
| Identity                     | `auth.ts` (demo, password, Google OIDC), `users` / `organization_memberships`, account linking     |
| Onboarding / recovery        | invitations, activation, password reset, operator CLIs (`create-customer.ts`, `recover-member.ts`) |
| Agent provisioning           | `/api/provisioning`, admin decisions, `/api/organization/agents` batch creation with idempotency  |
| Signed manifests             | `manifest-signing.ts` (Ed25519, SPKI SHA-256 key id), `packages/contracts/src/manifest.ts`       |
| Client verification          | `apps/employee-desktop/src/app/verify-manifest.ts` (Web Crypto, ownership checks)                |
| Conversations                | `conversations`, `messages`, owner-scoped routes                                                  |
| Policy                       | `packages/policy-engine` static decisions; unknown and prototype keys deny                       |
| Approvals                    | `approvals` table, admin-only, self-approval forbidden, double decision → 409                   |
| Audit                        | `audit_events` (application), `organization_change_events` (immutable via triggers)              |
| Migrations                   | `migrations/index.ts` checksum-locked, `BEGIN IMMEDIATE`, fail-closed on edited migrations       |
| Security middleware          | helmet, CORS allow-list, verified-domain host resolution (421), rate limiting, 64 KB JSON limit   |
| CI                           | `.github/workflows/ci.yml` → `npm ci && npm run check`                                             |

## 3. Current limitations relevant to V2

1. **Execution model is QA-specific.** `QaRun`, `QaRunStatus`, `qa_runs`, the six-step plan and
   the `qa.execute_playwright` approval are hard-coded. A second role would duplicate all of it.
2. **No thread/run separation.** A conversation directly owns QA runs; there is no durable work
   context separate from a single invocation, no run steps and no event history.
3. **No runtime boundary.** There is no protocol, process or contract between the control plane
   and anything that executes. `READY` is a terminal state in practice.
4. **Manifest v1 is QA-shaped.** `AgentManifestPayload` embeds QA questionnaire `answers` and a
   flat capability list. It has no skills, tools, connectors, MCP, workflows, runtime profile,
   memory, knowledge, or evaluation sections. The desktop verifier accepts only v1.
5. **Blueprint is a single constant.** `blueprints.ts` exports `qaBlueprint`; the provisioning
   schema uses `z.literal(qaBlueprint.id)`. There is no catalog, versioning, installation or
   per-organization customization layer.
6. **Policy is action → static result.** No actor, resource, environment or manifest context;
   no `policyId`/`policyVersion` on decisions. It is deterministic and fail-closed, which is the
   property to keep.
7. **Approvals are loosely typed.** `resource_type`/`resource_id` are strings; there is no link to
   a run, step, agent or evidence, and no expiry.
8. **Audit mixes concerns.** `audit_events` records security and product mutations, is not
   protected by immutability triggers, and there is no runtime event stream.
9. **No artifacts.** Nothing stores evidence metadata; there is no storage reference model.
10. **Demo agent has no manifest.** `agent_qa_engineer` (seeded) is exempt from manifest checks
    in demo mode. Any generic run model must tolerate a run without a manifest in demo mode only.
11. **Baseline schema is not in the migration ledger.** `database.ts#migrate()` still creates the
    original tables with `CREATE TABLE IF NOT EXISTS`. New tables must use numbered migrations.
12. **`conversations` and `agents` lack `(organization_id, id)` unique keys**, so new tables cannot
    use composite tenant foreign keys against them without an additive index.

## 4. Files/modules affected by Phase A

| File                                                     | Change                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                        | Re-export new contracts; generic `SignedManifest<P>`; optional run links    |
| `apps/control-plane-api/src/app.ts`                      | QA route dual-writes generic run; new read-only execution routes           |
| `apps/control-plane-api/src/database.ts`                 | Construct execution service; approval decision resumes linked runs         |
| `apps/control-plane-api/src/manifest-signing.ts`         | Sign/verify any manifest version; reject unknown `apiVersion`             |
| `apps/control-plane-api/src/migrations/index.ts`         | Register migration 006                                                     |
| `apps/employee-desktop/src/app/verify-manifest.ts`       | Accept v1 and v2 payloads with version-specific ownership checks           |
| `apps/employee-desktop/src/app/app.ts`                   | Read QA target URL from either manifest version                           |

## 5. New modules required (Phase A)

| Module                                                    | Responsibility                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/contracts/src/execution.ts`                     | Task, Thread, AgentRun, RunStep, AgentEvent, ToolCall/Result, etc.  |
| `packages/contracts/src/run-lifecycle.ts`                 | Deterministic run/step state machines shared by all hosts           |
| `packages/contracts/src/artifacts.ts`                     | Artifact, Evidence, storage reference and retention contracts       |
| `packages/contracts/src/manifest-v2.ts`                   | Agent Manifest v2 payload types                                     |
| `packages/contracts/src/runtime/v1/protocol.ts`           | `agents-foundry/runtime/v1` commands and event envelope types       |
| `packages/contracts/src/runtime/v1/schemas.ts`            | Zod parsers for the protocol and manifest v2 (Node consumers only)  |
| `apps/control-plane-api/src/migrations/006-agent-execution.ts` | Threads, runs, steps, events, artifacts; approval run links    |
| `apps/control-plane-api/src/execution/execution-service.ts` | Tenant-scoped persistence and transitions for the generic model   |
| `apps/control-plane-api/src/execution/execution-routes.ts`  | Versioned read API `/api/execution/v1/...`                         |
| `apps/control-plane-api/src/agents/manifest-v2.ts`        | QA compatibility adapter: blueprint + provisioning → Manifest v2    |

Later phases add `agent-runtime`, `execution-runtime` and `foundry-connectors` as separate
repositories only once their protocols are stable (see ADR 0002 and ADR 0007).

## 6. Data-model changes (migration 006, additive only)

```text
agent_threads      durable work context; one per (conversation, agent) for QA compatibility
agent_runs         one invocation; status machine; task JSON; manifest reference; legacy_qa_run_id
agent_run_steps    ordered logical steps (unique run_id + sequence)
agent_events       append-only, per-run monotonic sequence; UPDATE/DELETE blocked by triggers
agent_artifacts    metadata + opaque storage reference + SHA-256; no binary column; immutable
approvals          + run_id, + step_id (nullable, additive ALTER TABLE)
conversations      + UNIQUE(organization_id, id) index for composite tenant FKs
agents             + UNIQUE(organization_id, id) index for composite tenant FKs
```

Every new table carries `organization_id` and uses composite `(organization_id, …)` foreign
keys, matching migrations 001–005. Existing IDs and rows are untouched. `qa_runs` stays the
source of the legacy QA response; the generic run links to it through `legacy_qa_run_id`.

## 7. API changes

| Route                                         | Change                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| `POST /api/qa/runs`                           | Unchanged request; response gains optional `agentRun` link |
| `POST /api/approvals/:id/decision`            | Unchanged contract; additionally transitions a linked run |
| `GET /api/agents/:id/manifest`                | Unchanged; may return a v2 manifest when v2 issuance is enabled |
| `GET /api/execution/v1/threads/:id`           | New, read-only; owner employee or organization admin      |
| `GET /api/execution/v1/runs/:id`              | New, read-only; run + steps + artifacts                  |
| `GET /api/execution/v1/runs/:id/events`       | New, read-only; paginated by `afterSequence`             |

No runtime-ingestion HTTP route is added in Phase A: the runtime has no workload identity yet,
and an unauthenticated ingestion route would let a browser forge run history. The protocol
parser and the ingestion service method are implemented and tested so Phase C only adds a
properly authenticated transport.

## 8. Runtime protocol proposal

`agents-foundry/runtime/v1` (see `docs/runtime-protocol.md`):

- Control plane → runtime commands: `run.submit`, `run.resume`, `run.cancel`.
- Runtime → control plane: a single event envelope `{ protocol, eventId, runId, threadId,
  sequence, type, occurredAt, stepId?, correlation, payload }` whose `type` is a closed union.
- Every message is strict-parsed; unknown fields, unknown types and other protocol versions are
  rejected. Events are idempotent by `eventId` and ordered by per-run `sequence`.
- The control plane never interprets kernel internals; the payloads are the contract.

## 9. Migration sequence

Phases A–G from the brief, with Phase A limited to: contracts, persistence, QA dual-write,
approval-driven resume at the state level, Manifest v2 (behind a flag), and read APIs. See
`docs/migration-plan.md` for exit criteria per phase.

## 10. Backward compatibility strategy

- `/api/qa/runs` request and existing response fields are byte-for-byte compatible; the new
  `agentRun` field is optional and additive.
- `QaRun`, `QaRunStatus`, `qa_runs` remain. They are marked legacy, not deleted.
- Manifest v1 remains the default issued format. v2 issuance requires
  `AGENT_MANIFEST_V2_ISSUANCE_ENABLED=true`. Existing v1 manifests are never re-signed or
  mutated; both versions verify on the server and desktop.
- Migrations are additive and checksum-locked; the pre-existing schema is untouched.

## 11. Security implications

- Organization is always taken from the authenticated session; run reads recheck ownership
  (employee) or admin role, and are filtered by `organization_id` in SQL.
- Events and artifacts are immutable at the database level (triggers), mirroring
  `organization_change_events`.
- Unknown manifest `apiVersion` fails verification (`MANIFEST_INVALID`). Unknown runtime
  protocol version, event type, or illegal state transition is rejected.
- Artifacts store only opaque `artifact://` references; `data:`/`file:`/credential-bearing URIs
  are rejected so blobs and local paths cannot enter the database.
- No new write route reachable by a browser is added except the existing QA and approval
  routes, whose authorization is unchanged.

## 12. Testing strategy

- Contracts: protocol parsing (valid, unknown type, wrong version, extra fields, oversized
  payload), run/step state machines, manifest v2 schema and canonical signing round trip.
- Persistence: migration applies on a v5 database and preserves rows; triggers block event and
  artifact mutation; sequence uniqueness.
- Tenant isolation: organization B cannot read organization A's threads, runs, events or
  artifacts through the service or HTTP routes; employee B cannot read employee A's runs.
- Compatibility: existing QA flow still returns the legacy shape; approval decisions still set
  `READY`/`REJECTED`, and now also resume/cancel the linked generic run.
- Manifest v2: issuance behind flag, server and desktop verification, tamper and wrong-owner
  rejection, unknown version rejection.

## 13. External dependencies

Phase A adds none. It reuses `zod` (already a dependency, hoisted to the root) and Node's
built-in `node:sqlite` and `node:crypto`. Candidate future dependencies (model SDKs, MCP SDK,
Playwright, sandbox providers) are deferred to their phases and belong outside the control
plane process.

## 14. Licensing notes

No third-party code is copied in Phase A. External projects are architectural references only
and are recorded in `docs/third-party-architecture.md`; `docs/third-party-code.md` is the
ledger for any future copied code and is currently empty. RoboCo is treated as AGPL (per the
brief) and must not contribute code to the commercial core.

## 15. Risks

| Risk                                                             | Mitigation                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Dual-write divergence between `qa_runs` and `agent_runs`         | Same transaction; legacy row is authoritative for the legacy response    |
| Contract churn before the runtime exists                         | Versioned protocol; parser tests; changes require a new version          |
| Manifest v2 shape wrong for later roles                          | Issued only behind a flag until the Frontend Engineer role validates it  |
| `database.ts` keeps growing                                      | New logic lives in `execution/` and `agents/` modules                    |
| SQLite single-writer limits for event volume                     | Accepted for development; PostgreSQL move is a separate planned change   |
| Over-claiming capability                                         | Docs state explicitly that no runtime, tool, or connector executes yet   |

## 16. Rollback strategy

- Code: revert the Phase A commits; the legacy QA path does not depend on the new tables.
- Data: migration 006 only adds tables, nullable columns and indexes. Rolling code back leaves
  them unused; do not drop them or edit the migration (checksum lock). A forward-only corrective
  migration is the supported repair path.
- Manifests: v2 issuance is off by default. If enabled and rolled back, v2 manifests already
  issued remain verifiable by the v1-aware signer only if the code still recognizes v2; roll back
  the flag first and keep the verifier until no v2 manifest is active.

## Discrepancies with the brief

- The brief lists `packages/web-auth`; it exists and is unaffected by Phase A.
- The brief describes "Tasks" as a persisted entity. Phase A defines `TaskSpec` as the task
  payload of a run (persisted on `agent_runs.task`). A standalone task backlog is deferred until
  a workflow needs to assign one task to several threads.
- "Workspace" is contracts-only in Phase A because nothing can yet create one safely; this is
  consistent with the brief's Phase A list ("Workspace contracts").
