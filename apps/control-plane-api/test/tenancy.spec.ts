import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@agents-foundry/contracts';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { migrateOrganization } from '../src/migrations/index.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const profile = (before: { name: string; code: string; slug: string; version: number }) => ({
  name: before.name,
  legalName: 'Example GmbH',
  code: before.code,
  slug: before.slug,
  website: 'https://example.org',
  industry: 'Software',
  country: 'DE',
  timezone: 'Europe/Berlin',
  locale: 'en',
  version: before.version,
});
const person = (email: string) => ({
  displayName: 'Ada Engineer',
  email,
  employeeNumber: 'E-42',
  employmentType: 'employee',
});
const positionContext = (db: ControlPlaneDatabase, actor: Actor) => {
  const unit = db.structure.save(actor, {
    name: 'Engineering',
    code: 'ENG',
    unitType: 'department',
    parentId: null,
    description: '',
  });
  const family = db.jobs.save(actor, 'families', {
    name: 'Engineering',
    code: 'ENG',
    description: '',
  });
  const discipline = db.jobs.save(actor, 'disciplines', {
    name: 'Quality',
    code: 'QUALITY',
    description: '',
    jobFamilyId: family.id,
  });
  const role = db.jobs.save(actor, 'roles', {
    name: 'QA Engineer',
    code: 'QA',
    description: '',
    jobFamilyId: family.id,
    disciplineId: discipline.id,
  });
  const level = db.jobs.save(actor, 'levels', {
    name: 'Senior',
    code: 'L3',
    rank: 3,
    description: '',
  });
  return db.jobs.save(actor, 'positions', {
    name: 'Senior QA',
    code: 'SQA',
    description: '',
    organizationalUnitId: unit.id,
    roleId: role.id,
    jobLevelId: level.id,
    reportsToPositionId: null,
  });
};
describe('tenant profile, account separation, membership and positions', () => {
  let db: ControlPlaneDatabase, admin: Actor, peer: Actor;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    const create = (slug: string): Actor => {
      const invitation = db.createCustomer(
        { name: slug, slug },
        { displayName: 'Admin', email: `admin@${slug}.example`, team: 'Administration' },
      );
      db.acceptInvitation(hashToken(invitation.token), 'test-hash');
      return {
        id: invitation.employeeId,
        organizationId: invitation.organizationId,
        role: 'ADMIN',
      };
    };
    admin = create('alpha');
    peer = create('beta');
  });
  afterEach(() => db.close());
  it('separates user, employee and membership and gates existing sessions on status', () => {
    const member = db.tenancy.listMemberships(admin, {}).items[0];
    expect(member.userId).not.toBe(member.employeeId);
    expect(member.securityRole).toBe('ADMIN');
    const invite = db.inviteEmployee(admin, {
      displayName: 'Worker',
      email: 'worker@alpha.example',
      team: 'QA',
    });
    expect(db.tenancy.listMemberships(admin, {}).total).toBe(2);
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)).toBeUndefined();
    db.acceptInvitation(hashToken(invite.token), 'test-hash');
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)?.role).toBe('EMPLOYEE');
    const workerToken = randomBytes(32).toString('base64url');
    db.createSession(hashToken(workerToken), LOCAL_ISSUER, invite.employeeId, Date.now() + 60000);
    expect(db.findSession(hashToken(workerToken))).toBeDefined();
    const worker = db.tenancy.listMemberships(admin, { search: 'worker' }).items[0];
    db.tenancy.setMembershipStatus(admin, worker.id, {
      status: 'suspended',
      version: worker.version,
    });
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)).toBeUndefined();
    expect(db.findSession(hashToken(workerToken))).toBeUndefined();
    const suspended = db.tenancy.listMemberships(admin, { search: 'worker' }).items[0];
    db.tenancy.setMembershipStatus(admin, worker.id, {
      status: 'active',
      version: suspended.version,
    });
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)).toBeDefined();
    expect(db.findSession(hashToken(workerToken))).toBeUndefined();
    db.disableMember(admin, invite.employeeId);
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)).toBeUndefined();
    const disabled = db.tenancy.listMemberships(admin, { search: 'worker' }).items[0];
    db.tenancy.setMembershipStatus(admin, disabled.id, {
      status: 'active',
      version: disabled.version,
    });
    expect(db.findIdentity(LOCAL_ISSUER, invite.employeeId)).toBeDefined();
    expect(() =>
      db.tenancy.setMembershipStatus(admin, member.id, {
        status: 'suspended',
        version: member.version,
      }),
    ).toThrow('SELF_ROLE_CHANGE_FORBIDDEN');
    expect(
      db.tenancy
        .listMemberships(peer, {})
        .items.some((item) => item.employeeId === invite.employeeId),
    ).toBe(false);
  });
  it('persists organization profile and verifies DNS ownership before domain routing', async () => {
    const before = db.tenancy.profile(admin);
    expect(before.name).toBe('alpha');
    const updated = db.tenancy.updateProfile(
      admin,
      profile({ ...before, name: 'Acme', code: 'ACME' }),
    );
    expect(updated.version).toBe(before.version + 1);
    expect(() => db.tenancy.updateProfile(admin, profile(before))).toThrow(
      'PROFILE_VERSION_CONFLICT',
    );
    expect(db.tenancy.profile(peer).name).toBe('beta');
    const domain = db.tenancy.registerDomain(admin, {
      domain: 'Agents.Acme.example.com',
      domainType: 'custom_domain',
    });
    expect(domain.domain).toBe('agents.acme.example.com');
    expect(db.tenancy.resolveVerifiedDomain(domain.domain)).toBeNull();
    expect(() => db.tenancy.setPrimaryDomain(admin, domain.id)).toThrow('DOMAIN_UNVERIFIED');
    await expect(
      db.tenancy.verifyDomain(admin, domain.id, async () => [['incorrect']]),
    ).rejects.toThrow('DOMAIN_PROOF_NOT_FOUND');
    const verified = await db.tenancy.verifyDomain(admin, domain.id, async (name) => {
      expect(name).toBe('_agents-foundry-verification.agents.acme.example.com');
      return [[domain.verificationToken!.slice(0, 14), domain.verificationToken!.slice(14)]];
    });
    expect(verified.verificationStatus).toBe('verified');
    expect(verified.verificationToken).toBeNull();
    db.tenancy.setPrimaryDomain(admin, domain.id);
    expect(db.tenancy.resolveVerifiedDomain(domain.domain)).toBe(admin.organizationId);
    expect(() =>
      db.tenancy.registerDomain(peer, { domain: domain.domain, domainType: 'custom_domain' }),
    ).toThrow('TENANT_RECORD_CONFLICT');
    const app = createApp(db, config),
      adminToken = randomBytes(32).toString('base64url'),
      peerToken = randomBytes(32).toString('base64url');
    db.createSession(hashToken(adminToken), LOCAL_ISSUER, admin.id, Date.now() + 60000);
    db.createSession(hashToken(peerToken), LOCAL_ISSUER, peer.id, Date.now() + 60000);
    await request(app)
      .get('/api/auth/session')
      .set('Host', domain.domain)
      .set('Cookie', `af_session=${adminToken}`)
      .expect(200);
    await request(app)
      .get('/api/auth/session')
      .set('Host', domain.domain)
      .set('Cookie', `af_session=${peerToken}`)
      .expect(401);
    await request(app)
      .post('/api/organization/employees')
      .set('Host', domain.domain)
      .set('Origin', `https://${domain.domain}`)
      .set('Cookie', `af_session=${adminToken}`)
      .send(person('domain@alpha.example'))
      .expect(201);
    const foreignOrigin = await request(app)
      .get('/api/auth/session')
      .set('Host', 'localhost')
      .set('Origin', `https://${domain.domain}`)
      .set('Cookie', `af_session=${peerToken}`);
    expect(foreignOrigin.headers['access-control-allow-origin']).toBeUndefined();
    const sql = (db as unknown as { db: DatabaseSync }).db;
    sql.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(admin.organizationId);
    expect(db.findIdentity(LOCAL_ISSUER, admin.id)).toBeUndefined();
    expect(db.tenancy.resolveVerifiedDomain(domain.domain)).toBeNull();
  });
  it('creates employees without login, assigns a tenant position, retains history and invites separately', () => {
    const position = positionContext(db, admin);
    const personRecord = db.tenancy.createEmployee(admin, person('ada@alpha.example'));
    expect(personRecord.userId).toBeNull();
    expect(db.findIdentity(LOCAL_ISSUER, personRecord.id)).toBeUndefined();
    expect(() =>
      db.tenancy.assignPosition(peer, personRecord.id, { positionId: position.id, version: 1 }),
    ).toThrow('EMPLOYEE_NOT_FOUND');
    const assigned = db.tenancy.assignPosition(admin, personRecord.id, {
      positionId: position.id,
      version: 1,
    });
    expect(assigned.positionTitle).toBe('Senior QA');
    expect(assigned.unitName).toBe('Engineering');
    expect(assigned.roleName).toBe('QA Engineer');
    expect(assigned.levelName).toBe('Senior');
    expect(() =>
      db.tenancy.assignPosition(admin, admin.id, { positionId: position.id, version: 1 }),
    ).toThrow('POSITION_OCCUPIED');
    const invitation = db.inviteExistingEmployee(admin, personRecord.id);
    expect(db.tenancy.listMemberships(admin, { search: 'ada' }).items[0].membershipStatus).toBe(
      'pending',
    );
    db.acceptInvitation(hashToken(invitation.token), 'test-hash');
    expect(db.findIdentity(LOCAL_ISSUER, personRecord.id)?.role).toBe('EMPLOYEE');
    const personToken = randomBytes(32).toString('base64url');
    db.createSession(hashToken(personToken), LOCAL_ISSUER, personRecord.id, Date.now() + 60000);
    const ended = db.tenancy.updateEmployee(admin, personRecord.id, {
      ...person('ada@alpha.example'),
      version: assigned.version,
      employmentStatus: 'inactive',
    });
    expect(ended.positionId).toBeNull();
    expect(db.findIdentity(LOCAL_ISSUER, personRecord.id)).toBeUndefined();
    expect(db.findSession(hashToken(personToken))).toBeUndefined();
    expect(() =>
      db.tenancy.assignPosition(admin, personRecord.id, {
        positionId: position.id,
        version: ended.version,
      }),
    ).toThrow('EMPLOYEE_INACTIVE');
    const sql = (db as unknown as { db: DatabaseSync }).db;
    expect(
      sql
        .prepare(
          'SELECT count(*) AS n FROM employee_position_assignments WHERE organization_id=? AND employee_id=? AND ended_at IS NOT NULL',
        )
        .get(admin.organizationId, personRecord.id)!['n'],
    ).toBe(1);
    expect(db.tenancy.listMemberships(admin, { search: 'ada' }).items[0].membershipStatus).toBe(
      'suspended',
    );
  });
  it('blocks unauthorized HTTP mutation and scopes profile, employees and memberships to the session tenant', async () => {
    const app = createApp(db, config),
      token = randomBytes(32).toString('base64url');
    db.createSession(hashToken(token), LOCAL_ISSUER, admin.id, Date.now() + 60000);
    const cookie = `af_session=${token}`;
    await request(app).get('/api/organization/profile').expect(401);
    const own = await request(app)
      .get('/api/organization/profile')
      .set('Cookie', cookie)
      .expect(200);
    expect(own.body.id).toBe(admin.organizationId);
    await request(app)
      .post('/api/organization/employees')
      .set('Cookie', cookie)
      .send(person('ada@alpha.example'))
      .expect(403);
    await request(app)
      .post('/api/organization/employees')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send({ ...person('ada@alpha.example'), organizationId: peer.organizationId })
      .expect(400);
    const created = await request(app)
      .post('/api/organization/employees')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send(person('ada@alpha.example'))
      .expect(201);
    expect(created.body.userId).toBeNull();
    const listing = await request(app)
      .get('/api/organization/employees?search=Ada&pageSize=1')
      .set('Cookie', cookie)
      .expect(200);
    expect(listing.body.total).toBe(1);
    const peerToken = randomBytes(32).toString('base64url');
    db.createSession(hashToken(peerToken), LOCAL_ISSUER, peer.id, Date.now() + 60000);
    const other = await request(app)
      .get('/api/organization/employees')
      .set('Cookie', `af_session=${peerToken}`)
      .expect(200);
    expect(other.body.items.some((item: { id: string }) => item.id === created.body.id)).toBe(
      false,
    );
    await request(app)
      .put(`/api/organization/employees/${created.body.id}/position`)
      .set('Cookie', `af_session=${peerToken}`)
      .set('Origin', 'http://localhost:4200')
      .send({ positionId: null, version: 1 })
      .expect(404);
    await request(app)
      .get('/api/organization/memberships?pageSize=1000')
      .set('Cookie', cookie)
      .expect(400);
  });
});

it('backfills legacy identities and leaves employees without login unlinked', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE);
      CREATE TABLE employees(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,display_name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,role TEXT NOT NULL,team TEXT NOT NULL,FOREIGN KEY(organization_id) REFERENCES organizations(id));
      CREATE TABLE identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,employee_id TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(issuer,subject),FOREIGN KEY(employee_id) REFERENCES employees(id));
      CREATE TABLE password_credentials(issuer TEXT NOT NULL,subject TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(issuer,subject));
      CREATE TABLE auth_sessions(hash TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE invitations(hash TEXT PRIMARY KEY,employee_id TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL);`);
    sql.prepare('INSERT INTO organizations VALUES (?,?,?)').run('legacy-org', 'Legacy', 'legacy');
    sql
      .prepare('INSERT INTO employees VALUES (?,?,?,?,?,?)')
      .run(
        'legacy-admin',
        'legacy-org',
        'Legacy Admin',
        'legacy@example.com',
        'ADMIN',
        'Administration',
      );
    sql
      .prepare('INSERT INTO employees VALUES (?,?,?,?,?,?)')
      .run(
        'legacy-offline',
        'legacy-org',
        'Offline Person',
        'offline@example.com',
        'EMPLOYEE',
        'QA',
      );
    sql
      .prepare('INSERT INTO identities VALUES (?,?,?,?)')
      .run(LOCAL_ISSUER, 'legacy-admin', 'legacy-admin', 1);
    sql
      .prepare('INSERT INTO password_credentials VALUES (?,?,?)')
      .run(LOCAL_ISSUER, 'legacy-admin', 'legacy-hash');
    sql
      .prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)')
      .run('legacy-session', LOCAL_ISSUER, 'legacy-admin', Date.now() + 60000);
    migrateOrganization(sql, 3);
    migrateOrganization(sql);
    const admin = sql.prepare('SELECT user_id FROM employees WHERE id=?').get('legacy-admin')![
      'user_id'
    ];
    expect(typeof admin).toBe('string');
    expect(admin).not.toBe('legacy-admin');
    expect(
      sql.prepare('SELECT user_id FROM employees WHERE id=?').get('legacy-offline')!['user_id'],
    ).toBeNull();
    expect(
      sql
        .prepare('SELECT membership_status FROM organization_memberships WHERE employee_id=?')
        .get('legacy-admin')!['membership_status'],
    ).toBe('active');
    expect(sql.prepare('SELECT count(*) AS n FROM schema_migrations').get()!['n']).toBe(5);
    expect(
      sql.prepare('SELECT hash FROM account_password_credentials WHERE user_id=?').get(admin)![
        'hash'
      ],
    ).toBe('legacy-hash');
    expect(
      sql
        .prepare('SELECT user_id,organization_id FROM auth_sessions WHERE hash=?')
        .get('legacy-session'),
    ).toEqual({ user_id: admin, organization_id: 'legacy-org' });
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    sql.close();
  }
});
