/**
 * Tenant isolation at the database level (ADR 0018): row-level security, role privileges and
 * scope rules, checked against PostgreSQL directly rather than through application queries.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@agents-foundry/contracts';
import { knownActions } from '../../../packages/policy-engine/src/index.js';
import { hashToken } from '../src/auth.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { assertSchemaCurrent, migrate } from '../src/db/migrate.js';
import { PgStore, toPositional } from '../src/db/pg-store.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { hashPassword } from '../src/passwords.js';
import { testDatabase, testStore, type TestStore } from './support/database.js';

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A tenant with an admin, an employee and data in most tenant tables, through normal flows. */
async function populate(db: ControlPlaneDatabase, slug: string, hash: string) {
  const org = await db.createCustomer(
    { name: slug, slug },
    { email: `admin@${slug}.example`, displayName: 'Admin', team: 'Admin' },
  );
  await db.acceptInvitation(hashToken(org.token), hash);
  const organizationId = org.organizationId;
  const admin: Actor = { id: org.employeeId, organizationId, role: 'ADMIN' };
  const invited = await db.inviteEmployee(admin, {
    email: `employee@${slug}.example`,
    displayName: 'Employee',
    team: 'QA',
  });
  await db.acceptInvitation(hashToken(invited.token), hash);
  const employee: Actor = { id: invited.employeeId, organizationId, role: 'EMPLOYEE' };
  const unit = await db.structure.save(admin, {
    name: 'Engineering',
    code: 'ENG',
    unitType: 'department',
    parentId: null,
    description: '',
  });
  await db.structure.addMember(admin, unit.id, {
    employeeId: employee.id,
    membershipType: 'member',
    isPrimary: true,
  });
  await db.jobs.save(admin, 'families', { name: 'Engineering', code: 'ENG', description: '' });
  await db.tenancy.registerDomain(admin, {
    domain: `${slug}-corp.com`,
    domainType: 'custom_domain',
  });
  await db.actionPolicies.set(admin, knownActions().sort()[0]!, {
    outcome: 'REQUIRE_APPROVAL',
    reason: 'Test override',
  });
  await db.connectors.create(admin, {
    provider: 'jira',
    name: 'Jira',
    baseUrl: `https://${slug}.atlassian.net`,
    secretRef: 'secret://jira-token',
    settings: { allowedProjects: ['QA'] },
  });
  const [assignment] = await db.createAssignedAgents(admin, {
    requestId: randomUUID(),
    name: 'Release QA',
    employeeIds: [employee.id],
    blueprintId: 'engineering.qa-engineer',
    blueprintVersion: '1.1.0',
    provider: 'test',
    model: 'test-model',
    credentialMode: 'ORGANIZATION_MANAGED',
    answers: {
      projectName: 'Pilot',
      repositoryUrl: 'https://example.com/repo',
      qaUrl: 'https://qa.example.com',
      issueTracker: ['Jira'],
      sourceControl: ['GitHub'],
      testingTechnologies: ['Playwright'],
    },
  });
  const conversation = await db.createConversation(
    employee.id,
    assignment!.agentId,
    'Checkout',
    organizationId,
    false,
  );
  await db.addMessage(conversation.id, 'EMPLOYEE', 'Validate QA-1', organizationId, employee.id);
  const qa = await db.createQaRun(
    {
      employeeId: employee.id,
      conversationId: conversation.id,
      storyKey: 'QA-1',
      targetUrl: 'https://qa.example.com/checkout',
      plan: ['Read QA-1'],
      approvalSummary: 'Approve QA-1',
    },
    organizationId,
    false,
  );
  return { organizationId, admin, employee, approvalId: qa.approval.id };
}

describe('row-level security', () => {
  let fixture: TestStore;
  let db: ControlPlaneDatabase;
  let alpha: Awaited<ReturnType<typeof populate>>;
  let beta: Awaited<ReturnType<typeof populate>>;
  /** Tables with an organization_id column, from the catalog. */
  let tenantTables: string[];

  beforeAll(async () => {
    const hash = await hashPassword('a long test-only password');
    fixture = await testStore();
    db = await ControlPlaneDatabase.open({ store: fixture.store, signer: new ManifestSigner() });
    alpha = await populate(db, 'alpha', hash);
    beta = await populate(db, 'beta', hash);
    tenantTables = (
      await db.store.platform(() =>
        db.store.all<{ table_name: string }>(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='organization_id' ORDER BY table_name`,
        ),
      )
    ).map((row) => row.table_name);
  });
  afterAll(async () => {
    await fixture.drop();
  });

  it('forces row-level security with a tenant policy on every table that has an organization', async () => {
    const rows = await db.store.platform(() =>
      db.store.all<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`,
      ),
    );
    const policies = await db.store.platform(() =>
      db.store.all<{ tablename: string }>(
        "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname='public'",
      ),
    );
    const secured = rows.filter((row) => row.relrowsecurity && row.relforcerowsecurity);
    const withPolicy = new Set(policies.map((row) => row.tablename));
    expect(tenantTables.length).toBeGreaterThan(30);
    for (const table of [...tenantTables, 'organizations', 'users', 'identities']) {
      expect(
        secured.map((row) => row.relname),
        table,
      ).toContain(table);
      expect(withPolicy.has(table), table).toBe(true);
    }
  });

  it('shows a tenant exactly its own rows in every tenant table', async () => {
    let populated = 0;
    for (const table of tenantTables) {
      // Not granted to the tenant role at all (sign-in only).
      if (table === 'account_link_invitations') continue;
      const all = await db.store.platform(() =>
        db.store.all<{ organization_id: string | null }>(`SELECT organization_id FROM ${table}`),
      );
      const seen = await db.store.tenant(alpha.organizationId, () =>
        db.store.all<{ organization_id: string }>(`SELECT organization_id FROM ${table}`),
      );
      const own = all.filter((row) => row.organization_id === alpha.organizationId);
      expect(seen, table).toHaveLength(own.length);
      expect(new Set(seen.map((row) => row.organization_id)), table).toEqual(
        new Set(own.length ? [alpha.organizationId] : []),
      );
      if (own.length && all.some((row) => row.organization_id === beta.organizationId)) populated++;
    }
    // The fixture puts rows for both tenants in most tables; isolation is not vacuous.
    expect(populated).toBeGreaterThanOrEqual(20);
    const organizations = await db.store.tenant(alpha.organizationId, () =>
      db.store.all<{ id: string }>('SELECT id FROM organizations'),
    );
    expect(organizations).toEqual([{ id: alpha.organizationId }]);
    const users = await db.store.tenant(alpha.organizationId, () =>
      db.store.all<{ email: string }>('SELECT email FROM users ORDER BY email'),
    );
    expect(users.map((row) => row.email)).toEqual([
      'admin@alpha.example',
      'employee@alpha.example',
    ]);
  });

  it('refuses writes that name another tenant, even with its identifiers', async () => {
    await expect(
      db.store.tenant(alpha.organizationId, () =>
        db.store.run(
          `INSERT INTO audit_events (id, organization_id, actor_id, event_type, resource_type, resource_id, metadata, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          randomUUID(),
          beta.organizationId,
          alpha.admin.id,
          'forged',
          'test',
          'test',
          '{}',
          new Date().toISOString(),
        ),
      ),
    ).rejects.toThrow('row-level security');
    const updated = await db.store.tenant(alpha.organizationId, () =>
      db.store.run(
        "UPDATE employees SET team='Hijacked' WHERE organization_id=?",
        beta.organizationId,
      ),
    );
    expect(updated.changes).toBe(0);
    const deleted = await db.store.tenant(alpha.organizationId, () =>
      db.store.run(
        'DELETE FROM organization_action_policies WHERE organization_id=?',
        beta.organizationId,
      ),
    );
    expect(deleted.changes).toBe(0);
    // Moving an own row into another tenant fails the policy's check.
    await expect(
      db.store.tenant(alpha.organizationId, () =>
        db.store.run(
          'UPDATE organization_action_policies SET organization_id=? WHERE organization_id=?',
          beta.organizationId,
          alpha.organizationId,
        ),
      ),
    ).rejects.toThrow();
    expect(
      await db.store.platform(() => db.store.all("SELECT 1 FROM employees WHERE team='Hijacked'")),
    ).toEqual([]);
  });

  it('never grants the tenant role password hashes, tokens, login state or runtime nonces', async () => {
    for (const sql of [
      'SELECT hash FROM password_credentials',
      'SELECT hash FROM account_password_credentials',
      'SELECT hash FROM auth_sessions',
      'SELECT subject FROM identities',
      'SELECT * FROM login_transactions',
      'SELECT * FROM invitations',
      'SELECT * FROM password_resets',
      'SELECT * FROM account_link_invitations',
      'SELECT * FROM runtime_request_nonces',
      "INSERT INTO organizations (id, name, slug) VALUES ('x', 'x', 'x')",
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('x', 'x', 'x', '2026-01-01T00:00:00.000Z')",
      "UPDATE catalog_blueprint_versions SET digest='x'",
      "UPDATE schema_migrations SET checksum='x'",
    ])
      await expect(
        db.store.tenant(alpha.organizationId, () => db.store.all(sql)),
        sql,
      ).rejects.toThrow('permission denied');
  });

  it('shows nothing to a tenant connection without an organization, or to the owner', async () => {
    for (const url of [fixture.urls.tenant, fixture.urls.owner]) {
      const counts = await withClient(url, async (client) => {
        const result: number[] = [];
        for (const table of ['employees', 'agents', 'agent_runs', 'approvals', 'organizations'])
          result.push(Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n));
        return result;
      });
      expect(counts).toEqual([0, 0, 0, 0, 0]);
    }
    // With the setting for one tenant, only that tenant's rows appear.
    const seen = await withClient(fixture.urls.tenant, async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        beta.organizationId,
      ]);
      const rows = (await client.query('SELECT DISTINCT organization_id FROM employees')).rows;
      await client.query('COMMIT');
      return rows.map((row) => row.organization_id);
    });
    expect(seen).toEqual([beta.organizationId]);
  });

  it('fails closed on scope misuse and on a tenant role that could bypass row security', async () => {
    await expect(db.store.all('SELECT 1')).rejects.toThrow('DATABASE_SCOPE_REQUIRED');
    await expect(
      db.store.tenant(alpha.organizationId, () =>
        db.store.tenant(beta.organizationId, async () => 1),
      ),
    ).rejects.toThrow('WRONG_ORGANIZATION');
    await expect(
      db.store.tenant(alpha.organizationId, () => db.store.platform(async () => 1)),
    ).rejects.toThrow('PLATFORM_SCOPE_FORBIDDEN');
    expect(() => db.store.tenant('', async () => 1)).toThrow('ORGANIZATION_REQUIRED');
    await expect(
      PgStore.connect({ tenantUrl: fixture.urls.platform, platformUrl: fixture.urls.platform }),
    ).rejects.toThrow('TENANT_ROLE_BYPASSES_ROW_SECURITY');
  });

  it('rejects tampered migration history at migration and at startup', async () => {
    const { store, urls, drop } = await testStore();
    try {
      await withClient(urls.owner, (client) =>
        client.query("UPDATE schema_migrations SET checksum='tampered' WHERE version=1"),
      );
      await expect(migrate(urls.owner)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
      await expect(
        ControlPlaneDatabase.open({ store, signer: new ManifestSigner() }),
      ).rejects.toThrow('DATABASE_SCHEMA_MISMATCH');
      await expect(assertSchemaCurrent(async () => [])).rejects.toThrow('DATABASE_SCHEMA_MISMATCH');
      await expect(
        assertSchemaCurrent(async () => {
          throw new Error('relation "schema_migrations" does not exist');
        }),
      ).rejects.toThrow('DATABASE_NOT_MIGRATED');
    } finally {
      await drop();
    }
  });
});

describe('concurrent decisions', () => {
  it('lets exactly one of two simultaneous approval decisions succeed', async () => {
    const db = await testDatabase();
    try {
      const conversation = await db.createConversation(
        'employee_qa_demo',
        'agent_qa_engineer',
        'Race',
      );
      const { approval } = await db.createQaRun({
        employeeId: 'employee_qa_demo',
        conversationId: conversation.id,
        storyKey: 'QA-9',
        targetUrl: 'https://qa.example.com',
        plan: ['Race'],
        approvalSummary: 'Approve QA-9',
      });
      const outcomes = await Promise.allSettled([
        db.decideApproval(approval.id, 'APPROVED', 'admin_demo'),
        db.decideApproval(approval.id, 'REJECTED', 'admin_demo'),
      ]);
      const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(String((failed[0] as PromiseRejectedResult).reason)).toContain(
        'APPROVAL_ALREADY_DECIDED',
      );
      const events = await db.store.platform(() =>
        db.store.all(
          "SELECT 1 FROM audit_events WHERE event_type IN ('approval.approved','approval.rejected')",
        ),
      );
      expect(events).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});

describe('positional parameters', () => {
  it('numbers placeholders outside string literals, quoted identifiers and comments', () => {
    expect(toPositional('SELECT ?, \'?\', "a?" -- ?\n, ?')).toBe(
      'SELECT $1, \'?\', "a?" -- ?\n, $2',
    );
    expect(toPositional("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
    expect(() => toPositional("SELECT '?")).toThrow('SQL_UNTERMINATED_QUOTE');
  });
});
