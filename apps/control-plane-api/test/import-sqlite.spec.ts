import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { isKnownAction } from '../../../packages/policy-engine/src/index.js';
import { hashToken } from '../src/auth.js';
import { resolveCatalog } from '../src/catalog/catalog-registry.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { importSqlite } from '../src/db/import-sqlite.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { migrateSqlite } from '../src/migrations/index.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import { testStore, type TestStore } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const STAMP = '2026-01-15T10:00:00.000Z';
const SESSION = 'imported-session-token-value-0000000000000';

/** A SQLite control-plane database (schema 011) with the awkward cases an import must keep. */
function fixture(path: string, passwordHash: string): void {
  const sql = new DatabaseSync(path);
  try {
    migrateSqlite(sql);
    const run = (statement: string, ...values: (string | number | null)[]) =>
      sql.prepare(statement).run(...values);
    const bundle = resolveCatalog(builtInCatalog, isKnownAction).find(
      (item) =>
        item.content.blueprint.id === 'engineering.qa-engineer' &&
        item.content.blueprint.version === '1.1.0',
    )!;
    run(
      'INSERT INTO catalog_blueprint_versions VALUES (?,?,?,?,?)',
      'engineering.qa-engineer',
      '1.1.0',
      bundle.digest,
      JSON.stringify(bundle.content),
      STAMP,
    );
    for (const [org, name] of [
      ['org-a', 'Alpha'],
      ['org-b', 'Beta'],
    ])
      run(
        'INSERT INTO organizations (id, name, slug) VALUES (?,?,?)',
        org!,
        name!,
        name!.toLowerCase(),
      );
    const people = [
      ['e-a-admin', 'u-a-admin', 'org-a', 'ADMIN', 'admin@alpha.example'],
      ['e-a-emp', 'u-a-emp', 'org-a', 'EMPLOYEE', 'employee@alpha.example'],
      ['e-b-admin', 'u-b-admin', 'org-b', 'ADMIN', 'admin@beta.example'],
    ] as const;
    for (const [employee, user, org, role, email] of people) {
      run(
        'INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)',
        user,
        email,
        email,
        STAMP,
      );
      run(
        'INSERT INTO employees (id,organization_id,display_name,email,role,team,user_id) VALUES (?,?,?,?,?,?,?)',
        employee,
        org,
        email,
        email,
        role,
        'Team',
        user,
      );
      run(
        `INSERT INTO organization_memberships (id,organization_id,user_id,employee_id,security_role,membership_status,joined_at,updated_at)
         VALUES (?,?,?,?,?,'active',?,?)`,
        `m-${employee}`,
        org,
        user,
        employee,
        role,
        STAMP,
        STAMP,
      );
      run('INSERT INTO identities VALUES (?,?,?,1,?)', LOCAL_ISSUER, employee, employee, user);
      run('INSERT INTO password_credentials VALUES (?,?,?)', LOCAL_ISSUER, employee, passwordHash);
      run('INSERT INTO account_password_credentials VALUES (?,?,?)', user, passwordHash, STAMP);
    }
    run(
      'INSERT INTO auth_sessions (hash,issuer,subject,expires_at,user_id,organization_id) VALUES (?,?,?,?,?,?)',
      hashToken(SESSION),
      LOCAL_ISSUER,
      'u-a-emp',
      Date.now() + 3_600_000,
      'u-a-emp',
      'org-a',
    );
    // A retired installation that still has an agent (the trigger forbids this for new agents).
    run(
      `INSERT INTO organization_agent_installations VALUES (?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`,
      'inst-a',
      'org-a',
      'Checkout QA',
      'engineering.qa-engineer',
      '1.1.0',
      '{}',
      'e-a-admin',
      STAMP,
      'e-a-admin',
      STAMP,
    );
    for (const [agent, org, installation] of [
      ['agent-a', 'org-a', 'inst-a'],
      ['agent-b', 'org-b', null],
    ])
      run(
        'INSERT INTO agents (id,organization_id,name,department,team,status,capabilities,installation_id) VALUES (?,?,?,?,?,?,?,?)',
        agent!,
        org!,
        'QA',
        'Engineering',
        'QA',
        'ACTIVE',
        '[]',
        installation ?? null,
      );
    run("UPDATE organization_agent_installations SET status='RETIRED',version=2 WHERE id='inst-a'");
    run('INSERT INTO agent_assignments VALUES (?,?,?)', 'agent-a', 'e-a-admin', STAMP);
    run(
      'INSERT INTO conversations VALUES (?,?,?,?,?,?,?)',
      'conv-a',
      'org-a',
      'e-a-emp',
      'agent-a',
      'Checkout',
      STAMP,
      STAMP,
    );
    // Same timestamp: only insertion order tells them apart.
    for (const message of ['m-zeta', 'm-alpha'])
      run('INSERT INTO messages VALUES (?,?,?,?,?)', message, 'conv-a', 'EMPLOYEE', message, STAMP);
    for (const [id, type] of [
      ['audit-b', 'organization.created'],
      ['audit-a', 'employee.invited'],
    ])
      run(
        'INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)',
        id!,
        'org-a',
        'platform-operator',
        type!,
        'organization',
        'org-a',
        '{}',
        STAMP,
      );
    const common = [STAMP, STAMP, 'e-a-admin', 'e-a-admin'];
    const unit = (id: string, parent: string | null, code: string) =>
      run(
        `INSERT INTO organizational_units (id,organization_id,parent_id,name,code,unit_type,created_at,updated_at,created_by,updated_by)
         VALUES (?,'org-a',?,?,?,'department',?,?,?,?)`,
        id,
        parent,
        id,
        code,
        ...common,
      );
    // Active units whose head position lives inside the unit: a circular reference.
    unit('unit-parent', null, 'ENG');
    unit('unit-child', 'unit-parent', 'QA');
    // History: an archived parent with an archived child (new writes could not create this).
    unit('unit-old', null, 'OLD');
    unit('unit-old-child', 'unit-old', 'OLDC');
    run("UPDATE organizational_units SET status='archived' WHERE id='unit-old-child'");
    run("UPDATE organizational_units SET status='archived' WHERE id='unit-old'");
    run(
      `INSERT INTO job_families (id,organization_id,name,code,created_at,updated_at,created_by,updated_by) VALUES ('fam','org-a','Eng','ENG',?,?,?,?)`,
      ...common,
    );
    run(
      `INSERT INTO job_disciplines (job_family_id,id,organization_id,name,code,created_at,updated_at,created_by,updated_by) VALUES ('fam','disc','org-a','QA','QA',?,?,?,?)`,
      ...common,
    );
    run(
      `INSERT INTO roles (job_family_id,discipline_id,id,organization_id,name,code,created_at,updated_at,created_by,updated_by) VALUES ('fam','disc','role','org-a','QA','QA',?,?,?,?)`,
      ...common,
    );
    run(
      `INSERT INTO job_levels (rank,id,organization_id,name,code,created_at,updated_at,created_by,updated_by) VALUES (1,'lvl','org-a','L1','L1',?,?,?,?)`,
      ...common,
    );
    for (const [id, reportsTo] of [
      ['pos-lead', null],
      ['pos-member', 'pos-lead'],
    ])
      run(
        `INSERT INTO positions (organizational_unit_id,role_id,job_level_id,reports_to_position_id,id,organization_id,name,code,created_at,updated_at,created_by,updated_by)
         VALUES ('unit-child','role','lvl',?,?,'org-a',?,?,?,?,?,?)`,
        reportsTo ?? null,
        id!,
        id!,
        id!.toUpperCase(),
        ...common,
      );
    run("UPDATE organizational_units SET head_position_id='pos-lead' WHERE id='unit-child'");
    run(
      `INSERT INTO organization_change_events VALUES ('change-1','org-a','e-a-admin','ORG_UNIT_CREATED','organizational_unit','unit-parent',NULL,'{}','req-1',?)`,
      STAMP,
    );
  } finally {
    sql.close();
  }
}

describe('SQLite import', () => {
  let directory: string;
  let source: string;
  let target: TestStore;
  let passwordHash: string;
  let result: Awaited<ReturnType<typeof importSqlite>>;
  let sourceDigest: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'af-import-'));
    source = join(directory, 'agents-foundry.db');
    passwordHash = await hashPassword('a long test-only password');
    fixture(source, passwordHash);
    sourceDigest = createHash('sha256').update(readFileSync(source)).digest('hex');
    target = await testStore();
    result = await importSqlite(source, target.urls.owner);
  });
  afterAll(async () => {
    await target.drop();
    rmSync(directory, { recursive: true, force: true });
  });

  it('copies every row, leaves the source untouched and keeps insertion order', async () => {
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceDigest);
    expect(result.tables).toMatchObject({
      organizations: 2,
      users: 3,
      employees: 3,
      identities: 3,
      auth_sessions: 1,
      agents: 2,
      agent_assignments: 1,
      messages: 2,
      audit_events: 2,
      organizational_units: 4,
      positions: 2,
      organization_change_events: 1,
    });
    const db = await ControlPlaneDatabase.open({
      store: target.store,
      signer: new ManifestSigner(),
    });
    const conversation = await db.getConversation('conv-a', 'org-a', 'e-a-emp');
    expect(conversation.messages.map((message) => message.id)).toEqual(['m-zeta', 'm-alpha']);
    const events = await db.listLifecycleEvents('org-a');
    expect(events.map((event) => event.id)).toEqual(['audit-a', 'audit-b']);
    const units = await rawSql(db)
      .prepare(
        "SELECT id, parent_id, head_position_id, status FROM organizational_units WHERE organization_id='org-a' ORDER BY id",
      )
      .all();
    expect(units).toEqual([
      {
        id: 'unit-child',
        parent_id: 'unit-parent',
        head_position_id: 'pos-lead',
        status: 'active',
      },
      { id: 'unit-old', parent_id: null, head_position_id: null, status: 'archived' },
      { id: 'unit-old-child', parent_id: 'unit-old', head_position_id: null, status: 'archived' },
      { id: 'unit-parent', parent_id: null, head_position_id: null, status: 'active' },
    ]);
    const member = await rawSql(db)
      .prepare("SELECT reports_to_position_id FROM positions WHERE id='pos-member'")
      .get();
    expect(member).toEqual({ reports_to_position_id: 'pos-lead' });
    const agent = await rawSql(db)
      .prepare("SELECT installation_id FROM agents WHERE id='agent-a'")
      .get();
    expect(agent).toEqual({ installation_id: 'inst-a' });
  });

  it('keeps sign-in working and sessions valid', async () => {
    const db = await ControlPlaneDatabase.open({
      store: target.store,
      signer: new ManifestSigner(),
    });
    const account = await db.findPasswordAccount('employee@alpha.example');
    expect(account).toMatchObject({ userId: 'u-a-emp', organizationId: 'org-a' });
    expect(await verifyPassword('a long test-only password', account!.hash)).toBe(true);
    expect(await db.findSession(hashToken(SESSION))).toEqual({
      id: 'e-a-emp',
      organizationId: 'org-a',
      role: 'EMPLOYEE',
    });
  });

  it('restores isolation, forced row security and triggers afterwards', async () => {
    const db = await ControlPlaneDatabase.open({
      store: target.store,
      signer: new ManifestSigner(),
    });
    const seen = await db.store.tenant('org-b', () => db.store.all('SELECT id FROM conversations'));
    expect(seen).toEqual([]);
    const owner = new pg.Client({ connectionString: target.urls.owner });
    await owner.connect();
    try {
      expect(Number((await owner.query('SELECT count(*) AS n FROM employees')).rows[0].n)).toBe(0);
    } finally {
      await owner.end();
    }
    await expect(rawSql(db).exec('DELETE FROM organization_change_events')).rejects.toThrow(
      'AUDIT_IMMUTABLE',
    );
  });

  it('refuses a target that already has data, and changes nothing', async () => {
    await expect(importSqlite(source, target.urls.owner)).rejects.toThrow(
      'IMPORT_TARGET_NOT_EMPTY',
    );
    const db = await ControlPlaneDatabase.open({
      store: target.store,
      signer: new ManifestSigner(),
    });
    expect((await rawSql(db).prepare('SELECT count(*) AS n FROM organizations').get())!['n']).toBe(
      2,
    );
  });
});
