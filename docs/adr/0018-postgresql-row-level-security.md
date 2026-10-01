# ADR 0018: PostgreSQL with row-level security

- Status: Accepted
- Date: 2026-09-28

## Context

The control plane stored everything in one SQLite file through synchronous `node:sqlite`.
Tenant isolation relied on application queries binding `organization_id`, plus composite
tenant foreign keys and triggers. A query that forgot the filter would have leaked another
organization's data, and SQLite allows only one writer, which limits event volume.

## Decision

1. **PostgreSQL is the control plane's only database.** Every service, route and CLI is
   async. Each unit of work runs in one `SERIALIZABLE` transaction that is retried on
   serialization failures and deadlocks. This replaces SQLite's single-writer
   `BEGIN IMMEDIATE` guarantees; for example, two simultaneous approval decisions cannot
   both succeed.

2. **Three login roles:**

   | Role     | Connection               | Row-level security           | Used for                                                                                                  |
   | -------- | ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
   | Owner    | `DATABASE_MIGRATION_URL` | Forced on its own tables     | Migrations and the SQLite import only                                                                     |
   | Tenant   | `DATABASE_URL`           | Enforced; must not bypass it | Everything done for one organization                                                                      |
   | Platform | `DATABASE_PLATFORM_URL`  | Bypassed (`BYPASSRLS`)       | Work that is cross-tenant by nature: sign-in, sessions, invitations, runtime claims, catalog registration |

   The API refuses to start if its tenant role is a superuser or has `BYPASSRLS`.

3. **Row-level security on every tenant table.** Every table with an `organization_id`
   (37 tables), plus `organizations`, is `FORCE ROW LEVEL SECURITY` with the policy
   `organization_id = af_current_organization()`, for both reads and writes.
   `af_current_organization()` reads `app.organization_id`, which the store sets per
   transaction with `set_config(..., true)`. When it is unset, it is NULL and matches no row.
   - `messages` and `agent_assignments` gained `organization_id` so that they can be isolated.
   - Global accounts are visible to a tenant only through membership: `users` and
     `account_password_credentials` rows of its members, and `identities` of its employees.

4. **Least privilege for the tenant role.**
   - It has no privileges on password hashes, session and invitation tokens, login
     transactions, password resets, account links, runtime nonces or migration history.
   - Narrow column grants let admins revoke their own organization's sessions and re-enable
     their employees' local sign-in. The session hash and identity subject stay unreadable.
   - It can delete only from action-policy overrides.
   - It has no privileges to create organizations or accounts; those flows run in the platform scope.

5. **Scopes in code.** `PgStore` runs each query inside `tenant(organizationId, work)` or
   `platform(work)`. It fails closed in three ways:
   - a query outside any scope is refused (`DATABASE_SCOPE_REQUIRED`);
   - a nested scope for another organization is refused (`WRONG_ORGANIZATION`);
   - a platform scope inside a tenant scope is refused (`PLATFORM_SCOPE_FORBIDDEN`).

   Platform flows keep their explicit organization filters.

   The runtime transport reads the claim queue across tenants in the platform scope. Events,
   action requests, executions and grants for a leased run run in that run's tenant scope,
   where the lease is checked again.

6. **Migrations** are a new PostgreSQL series.
   - The baseline reproduces SQLite schema 011, with PL/pgSQL triggers that raise the same
     codes.
   - They are checksummed (line endings normalized) and applied under an advisory lock.
   - A mismatched or unknown schema stops startup.

   The SQLite migrations remain only to bring existing files to schema 011 for
   `npm run db:import-sqlite`. Released migrations stay immutable.

## Consequences

- A tenant query that forgets its organization filter now returns nothing from another
  tenant; it no longer depends on code review.
- Identifiers are still unique across tenants. A tenant scope cannot see another tenant's
  row, so such a collision surfaces as a primary-key violation, which is mapped to the same
  conflict codes as before. Unique constraints can therefore reveal that a value exists in
  another tenant, for example an email address. This is PostgreSQL's documented behaviour.
- The platform role bypasses row-level security. Its flows are reviewed code with explicit
  organization filters, the same guarantee SQLite gave everywhere. RLS does not protect
  against a database superuser or the platform role, and SQL injection could change
  `app.organization_id`; all queries are parameterized.
- Tests need PostgreSQL:
  - locally, a throwaway `postgres:16` container;
  - in CI, a service, via `TEST_DATABASE_ADMIN_URL`.

  Each test clones a migrated template database.

- The catalog of record is loaded at startup and served from memory. A version registered
  later by another instance is unknown to this one until it restarts, and fails closed.
- Each HTTP request resolves verified tenant domains with a database round trip. There is
  no cache yet. (Cached since [ADR 0027](0027-tenant-domain-cache.md).)
- Timestamps stay ISO-8601 text and JSON stays text, as in SQLite, so digests and ordering
  are unchanged. Moving them to native types is separate work. (Done in
  [ADR 0028](0028-native-column-types.md).)
- The execution runtime keeps its own local SQLite state for workspaces and operations. It
  holds no multi-tenant control-plane data.
