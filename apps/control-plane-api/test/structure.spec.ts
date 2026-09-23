import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import type { Actor } from '@agents-foundry/contracts';
import { migrateOrganization } from '../src/migrations/index.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const payload = (name = 'Engineering', parentId: string | null = null) => ({
  name,
  code: name.toUpperCase(),
  unitType: 'department',
  parentId,
  description: '',
});
it('rolls back a failed migration and can resume without partial job tables', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE organizations(id TEXT PRIMARY KEY);
      CREATE TABLE employees(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL);
      CREATE TABLE roles(id TEXT PRIMARY KEY);`);
    expect(() => migrateOrganization(sql, 2)).toThrow();
    expect(sql.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(
      sql
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('job_families','job_disciplines')")
        .all(),
    ).toEqual([]);
    sql.exec('DROP TABLE roles');
    migrateOrganization(sql, 2);
    expect(sql.prepare('SELECT count(*) AS n FROM schema_migrations').get()!['n']).toBe(2);
  } finally {
    sql.close();
  }
});
describe('organization structure', () => {
  let db: ControlPlaneDatabase, admin: Actor, other: Actor, employee: Actor;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    const customer = (slug: string): Actor => {
      const invitation = db.createCustomer(
        { name: slug, slug },
        { email: `admin@${slug}.example`, displayName: 'Admin', team: 'Admin' },
      );
      db.acceptInvitation(hashToken(invitation.token), 'test-credential-not-used-for-login');
      return {
        id: invitation.employeeId,
        organizationId: invitation.organizationId,
        role: 'ADMIN',
      };
    };
    admin = customer('alpha');
    other = customer('beta');
    const invited = db.inviteEmployee(admin, {
      email: 'employee@alpha.example',
      displayName: 'Employee',
      team: 'Legacy team',
    });
    db.acceptInvitation(hashToken(invited.token), 'test-credential-not-used-for-login');
    employee = { id: invited.employeeId, organizationId: admin.organizationId, role: 'EMPLOYEE' };
  });
  afterEach(() => db.close());

  it('supports tenant-scoped structure, moves, breadcrumbs, filtering and stable pagination', () => {
    const parent = db.structure.save(admin, payload());
    const qa = db.structure.save(admin, payload('QA', parent.id));
    const team = db.structure.save(admin, { ...payload('Automation', qa.id), unitType: 'team' });
    expect(db.structure.ancestors(admin, team.id).map((row) => row.name)).toEqual([
      'Engineering',
      'QA',
      'Automation',
    ]);
    expect(db.structure.list(admin, { parentId: parent.id }).items.map((row) => row.id)).toEqual([
      qa.id,
    ]);
    expect(db.structure.list(admin, { unitType: 'team', search: 'auto', pageSize: 1 }).total).toBe(
      1,
    );
    expect(db.structure.list(other, {}).total).toBe(0);
    const moved = db.structure.save(
      admin,
      { ...payload('Automation', parent.id), unitType: 'team', version: 1 },
      team.id,
    );
    expect(moved.version).toBe(2);
    expect(db.structure.ancestors(admin, team.id).map((row) => row.name)).toEqual([
      'Engineering',
      'Automation',
    ]);
    expect(db.structure.list(admin, { pageSize: 1, page: 2 }).items).toHaveLength(1);
  });

  it('rejects cycles, cross-tenant links, stale writes, duplicates, and tenant spoofing', () => {
    const parent = db.structure.save(admin, payload());
    const child = db.structure.save(admin, payload('QA', parent.id));
    expect(() =>
      db.structure.save(admin, { ...payload('Engineering', child.id), version: 1 }, parent.id),
    ).toThrow('HIERARCHY_CONFLICT');
    expect(() =>
      db.structure.save(admin, { ...payload('Engineering', parent.id), version: 1 }, parent.id),
    ).toThrow('HIERARCHY_CYCLE');
    expect(() => db.structure.save(other, payload('Intruder', parent.id))).toThrow(
      'UNIT_NOT_FOUND',
    );
    expect(() => db.structure.save(other, { ...payload(), version: 1 }, parent.id)).toThrow(
      'UNIT_NOT_FOUND',
    );
    expect(() => db.structure.save(admin, { ...payload(), version: 99 }, parent.id)).toThrow(
      'UNIT_VERSION_CONFLICT',
    );
    expect(() => db.structure.save(admin, payload())).toThrow('CODE_OR_MEMBERSHIP_CONFLICT');
    expect(() =>
      db.structure.save(admin, { ...payload('New'), organizationId: other.organizationId }),
    ).toThrow();
    expect(() => db.structure.save({ ...employee, role: 'ADMIN' }, payload('Fake'))).toThrow(
      'ORGANIZATION_ADMIN_REQUIRED',
    );
    expect(db.structure.list(admin, {}).total).toBe(2);
  });

  it('supports multiple memberships and one primary, without granting RBAC permissions', () => {
    const engineering = db.structure.save(admin, payload());
    const qa = db.structure.save(admin, payload('QA'));
    const input = { employeeId: employee.id, membershipType: 'lead', isPrimary: true };
    db.structure.addMember(admin, engineering.id, input);
    expect(() => db.structure.addMember(admin, qa.id, input)).toThrow(
      'CODE_OR_MEMBERSHIP_CONFLICT',
    );
    db.structure.addMember(admin, qa.id, { ...input, isPrimary: false });
    expect(db.structure.members(admin, qa.id, {}).total).toBe(1);
    expect(() => db.structure.list(employee, {})).toThrow('ORGANIZATION_ADMIN_REQUIRED');
    expect(() => db.structure.addMember(admin, qa.id, { ...input, employeeId: other.id })).toThrow(
      'EMPLOYEE_NOT_FOUND',
    );
    expect(() => db.structure.archive(admin, engineering.id, 1)).toThrow('HIERARCHY_CONFLICT');
    const membership = db.structure.members(admin, engineering.id, {}).items[0];
    db.structure.removeMember(admin, engineering.id, membership.id);
    db.structure.archive(admin, engineering.id, 1);
    expect(db.structure.list(admin, { status: 'archived' }).total).toBe(1);
    expect(() => db.structure.addMember(admin, engineering.id, input)).toThrow('UNIT_INACTIVE');
  });

  it('retains hierarchy history and refuses to archive parents with active children', () => {
    const parent = db.structure.save(admin, payload());
    const child = db.structure.save(admin, payload('QA', parent.id));
    expect(() => db.structure.archive(admin, parent.id, 1)).toThrow('HIERARCHY_CONFLICT');
    db.structure.archive(admin, child.id, 1);
    db.structure.archive(admin, parent.id, 1);
    expect(db.structure.ancestors(admin, child.id)).toHaveLength(2);
    expect(db.structure.list(admin, { status: 'all' }).total).toBe(2);
  });

  it('enforces session, origin, role, strict validation and tenant scope through HTTP', async () => {
    const app = createApp(db, config);
    const cookie = (actor: Actor) => {
      const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
      db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 60000);
      return `af_session=${token}`;
    };
    const adminCookie = cookie(admin),
      otherCookie = cookie(other);
    await request(app).get('/api/organization/units').expect(401);
    await request(app).get('/api/organization/units').set('Cookie', cookie(employee)).expect(403);
    await request(app)
      .post('/api/organization/units')
      .set('Cookie', adminCookie)
      .send(payload())
      .expect(403);
    const result = await request(app)
      .post('/api/organization/units')
      .set('Cookie', adminCookie)
      .set('Origin', 'http://localhost:4200')
      .send(payload())
      .expect(201);
    await request(app)
      .put(`/api/organization/units/${result.body.id}`)
      .set('Cookie', otherCookie)
      .set('Origin', 'http://localhost:4200')
      .send({ ...payload(), version: 1 })
      .expect(404);
    await request(app)
      .get('/api/organization/units?pageSize=10000')
      .set('Cookie', adminCookie)
      .expect(400);
    await request(app)
      .post('/api/organization/units')
      .set('Cookie', adminCookie)
      .set('Origin', 'http://localhost:4200')
      .send({ ...payload(), organizationId: other.organizationId })
      .expect(400);
  });
});

it('applies migrations once, persists changes, and enforces cross-tenant keys and immutable audit at database level', () => {
  const directory = mkdtempSync(join(tmpdir(), 'af-structure-'));
  const path = join(directory, 'test.db');
  let db: ControlPlaneDatabase | undefined;
  let sql: DatabaseSync | undefined;
  try {
    db = new ControlPlaneDatabase(path, false);
    const create = (slug: string) => {
      const result = db!.createCustomer(
        { name: slug, slug },
        { email: `${slug}@example.com`, displayName: slug, team: 'Admin' },
      );
      db!.acceptInvitation(hashToken(result.token), 'unused');
      return {
        id: result.employeeId,
        organizationId: result.organizationId,
        role: 'ADMIN' as const,
      };
    };
    const actor = create('first'),
      other = create('second');
    const root = db.structure.save(actor, payload());
    const child = db.structure.save(actor, payload('QA', root.id));
    db.close();
    db = undefined;
    db = new ControlPlaneDatabase(path, false);
    expect(db.structure.list(actor, {}).total).toBe(2);
    sql = new DatabaseSync(path);
    sql.exec('PRAGMA foreign_keys=ON');
    expect(sql.prepare('SELECT count(*) AS n FROM schema_migrations').get()!['n']).toBe(3);
    expect(() =>
      sql!
        .prepare('UPDATE organizational_units SET organization_id=? WHERE id=?')
        .run(other.organizationId, child.id),
    ).toThrow();
    expect(() =>
      sql!.prepare('UPDATE organizational_units SET parent_id=? WHERE id=?').run(child.id, root.id),
    ).toThrow('HIERARCHY_CYCLE');
    expect(() => sql!.exec('DELETE FROM organization_change_events')).toThrow('AUDIT_IMMUTABLE');
    expect(sql.prepare('SELECT count(*) AS n FROM organization_change_events').get()!['n']).toBe(2);
    sql.exec("UPDATE schema_migrations SET checksum='modified' WHERE version=1");
    expect(() => migrateOrganization(sql!)).toThrow('MIGRATION_CHECKSUM_MISMATCH');
  } finally {
    sql?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
