# Agent catalog

Architecture V2 Phase B. The catalog separates three layers:

```text
Global catalog definition      QA Engineer 1.1.0 (blueprint + pinned skills, tools, workflows)
        ↓ installed by an organization admin
Organization installation      "Checkout QA": Jira + Bitbucket + Playwright (org-wide answers)
        ↓ agent created for an employee
Agent instance + manifest      project, repository, QA URL (per-agent answers) → signed manifest
```

## Status

Implemented, meaning data model, validation, persistence, authorization, API, admin UI and tests:

- Declarative catalog definitions: blueprints, skills, tools and workflows (`packages/catalog`).
- Startup validation and registration into an immutable catalog of record, pinned by digest.
- Versioned catalog read API.
- Organization installations: create, update, retire, admin panel, and change events.
- Admin agent creation from an installation.
- A generic manifest resolver with no role-specific code (ADR 0009).

Not implemented yet:

- Loading role packages from external repositories.
- A catalog publishing and promotion workflow.
- Per-employee agent editing or re-issuing.
- Runtime use of skills and workflows beyond prompting. Phase C executes catalog tools that
  have a runtime implementation (`artifact`) and governs their actions (ADR 0011).
- Editing installations in the UI. Updates are API-only: `PUT /api/organization/agent-installations/:id`.

## Definitions

All shapes are in `packages/contracts/src/catalog.ts`. Strict schemas are in `catalog-schemas.ts`,
so role-package repositories can validate against the same contract.

| Kind       | Key fields                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------- |
| Skill      | `id`, `version`, `requires.tools`, `requires.connectorCapabilities`, `activatesWhen.workflows` |
| Tool       | `id`, `version`, `risk`, `executionLocation`, `sideEffects`, `governedActions`, `timeoutMs`   |
| Workflow   | `id`, `version`, `steps[]` of `{ id, title, skill, action? }`                                 |
| Blueprint  | Identity, persona, runtime, model profile, pinned skill/tool/workflow versions, connector requirements with answer→provider mappings, conditional MCP, memory, knowledge, `policy.actions`, evaluation suite, and a questionnaire whose questions are scoped `INSTALLATION` or `AGENT` |

Blueprints list the **actions** a role may ever request. The **outcome** of each action
(`ALLOW`, `REQUIRE_APPROVAL` or `DENY`) always comes from the policy engine at resolution time,
never from catalog data. A catalog can't grant itself permission.

## Validation (fails the whole catalog)

`resolveCatalog` rejects a catalog if any of these is true:

- A definition fails its schema. Unknown fields are rejected too.
- A version is a duplicate.
- A blueprint references a skill, tool or workflow version that doesn't exist.
- A skill needs a tool or connector capability the blueprint doesn't declare.
- A workflow step uses a skill or action the blueprint doesn't declare.
- A policy action is unknown to the policy engine.
- A connector mapping doesn't cover every option of its question.
- An MCP condition references an option that doesn't exist.

The API does not start with an invalid catalog.

## Catalog of record and version pinning (ADR 0010)

On startup each blueprint version is resolved into a bundle: the blueprint plus the exact
skill, tool and workflow definitions it pins. The bundle is hashed with SHA-256 over canonical
JSON and stored in `catalog_blueprint_versions`, which is immutable (update and delete are
blocked by triggers).

- If a shipped version's content no longer matches its registered digest, startup fails with
  `CATALOG_VERSION_MUTATED`. Change content only by adding a new version.
- Registered versions stay resolvable after they stop shipping, so installations and agents
  that reference them keep working.
- Installations and v2 manifests record the digest (`metadata.blueprint.digest`).

## Installations

`organization_agent_installations` is tenant-scoped. An installation holds validated answers
to the blueprint's `INSTALLATION`-scoped questions. An agent created from it supplies only
`AGENT`-scoped answers. Sending an installation-scoped answer is rejected, so employees' agents
cannot diverge from organization settings.

| Route under `/api/organization/agent-installations` | Method | Notes                                              |
| --------------------------------------------------- | ------ | -------------------------------------------------- |
| `/`                                                 | GET    | `?status=ACTIVE\|RETIRED\|all`                     |
| `/`                                                 | POST   | `{ name, blueprintId, blueprintVersion, configuration }` |
| `/:id`                                              | PUT    | `{ name, blueprintVersion, configuration, version }` (optimistic) |
| `/:id/retire`                                       | POST   | `{ version }`; retirement is final                 |

- Password-mode organization admins only, rechecked against live identity records.
- The tenant comes from the session, and unknown fields (including `organizationId`) are
  rejected. Other tenants' installations return 404.
- Active names are unique per organization, case-insensitive.
- Changes apply to agents created afterwards. Issued manifests are never modified.
- A retired installation cannot create agents. A database trigger enforces this even under a
  race. An unchanged retry of an already completed creation request still replays its original
  result.
- Every write records a before/after event in `organization_change_events`.

## Catalog API

| Route                                                | Who                  |
| ---------------------------------------------------- | -------------------- |
| `GET /api/catalog/v1/blueprints`                     | Any authenticated actor |
| `GET /api/catalog/v1/blueprints/:id/versions/:version` | Any authenticated actor; full bundle with policy-derived capabilities |
| `GET /api/blueprints` (legacy)                       | Unchanged shape: the latest version of each blueprint |

## Adding a role

Add skills, tools, workflows and a blueprint as data, then add the entries to
`packages/catalog/src/index.ts`. No platform code changes are needed. The catalog test suite
proves this with a synthetic Frontend Engineer, which resolves into a signed manifest without
touching the resolver. A new governed action still needs a policy-engine decision first, by
design.
