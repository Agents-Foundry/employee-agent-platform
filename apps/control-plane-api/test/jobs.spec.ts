import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import type { Actor } from '@agents-foundry/contracts';

const basic = (name: string) => ({ name, code: name.toUpperCase(), description: '' });
describe('job architecture', () => {
  let db: ControlPlaneDatabase, admin: Actor, other: Actor;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    const customer = (slug: string): Actor => {
      const invitation = db.createCustomer(
        { name: slug, slug },
        { email: `admin@${slug}.example`, displayName: 'Admin', team: 'Admin' },
      );
      db.acceptInvitation(hashToken(invitation.token), 'unused');
      return {
        id: invitation.employeeId,
        organizationId: invitation.organizationId,
        role: 'ADMIN',
      };
    };
    admin = customer('first');
    other = customer('second');
  });
  afterEach(() => db.close());
  const setup = () => {
    const unit = db.structure.save(admin, {
      ...basic('Engineering'),
      unitType: 'department',
      parentId: null,
    });
    const family = db.jobs.save(admin, 'families', basic('Engineering'));
    const discipline = db.jobs.save(admin, 'disciplines', {
      ...basic('Quality'),
      jobFamilyId: family.id,
    });
    const role = db.jobs.save(admin, 'roles', {
      ...basic('QA'),
      jobFamilyId: family.id,
      disciplineId: discipline.id,
    });
    const level = db.jobs.save(admin, 'levels', { ...basic('Senior'), rank: 3 });
    const position = {
      ...basic('Senior-QA'),
      organizationalUnitId: unit.id,
      roleId: role.id,
      jobLevelId: level.id,
      reportsToPositionId: null,
    };
    return { unit, family, discipline, role, level, position };
  };
  it('creates job families, disciplines, roles, levels and organizational positions independently of RBAC', () => {
    const data = setup();
    const position = db.jobs.save(admin, 'positions', data.position);
    expect(position.roleId).toBe(data.role.id);
    expect(db.jobs.list(admin, 'positions', { search: 'Senior', pageSize: 1 }).total).toBe(1);
    expect(db.jobs.list(other, 'positions', {}).total).toBe(0);
    const updated = db.jobs.save(
      admin,
      'positions',
      { ...data.position, name: 'Senior QA Engineer', version: 1 },
      position.id,
    );
    expect(updated.version).toBe(2);
    expect(() =>
      db.jobs.save(admin, 'positions', { ...data.position, version: 1 }, position.id),
    ).toThrow('JOB_VERSION_CONFLICT');
    expect(() => db.structure.archive(admin, data.unit.id, 1)).toThrow('HIERARCHY_CONFLICT');
    expect(() => db.jobs.archive(admin, 'roles', data.role.id, 1)).toThrow(
      'JOB_DEPENDENCY_CONFLICT',
    );
    db.jobs.archive(admin, 'positions', position.id, 2);
    db.jobs.archive(admin, 'roles', data.role.id, 1);
    expect(db.jobs.list(admin, 'positions', { status: 'archived' }).items).toHaveLength(1);
  });
  it('rejects foreign dependencies, mismatched family/discipline, duplicate codes and forged roles', () => {
    const data = setup();
    const foreign = db.jobs.save(other, 'families', basic('Foreign'));
    const another = db.jobs.save(admin, 'families', basic('Another'));
    expect(() =>
      db.jobs.save(admin, 'disciplines', { ...basic('Bad'), jobFamilyId: foreign.id }),
    ).toThrow('JOB_DEPENDENCY_NOT_FOUND');
    expect(() =>
      db.jobs.save(admin, 'roles', {
        ...basic('Bad'),
        jobFamilyId: another.id,
        disciplineId: data.discipline.id,
      }),
    ).toThrow('JOB_DEPENDENCY_CONFLICT');
    expect(() =>
      db.jobs.save(
        admin,
        'disciplines',
        { ...basic('Quality'), jobFamilyId: another.id, version: 1 },
        data.discipline.id,
      ),
    ).toThrow('JOB_DEPENDENCY_CONFLICT');
    expect(() => db.jobs.save(admin, 'families', basic('Engineering'))).toThrow(
      'JOB_DEPENDENCY_CONFLICT',
    );
    expect(() =>
      db.jobs.save(admin, 'roles', {
        ...basic('Admin'),
        jobFamilyId: data.family.id,
        disciplineId: data.discipline.id,
        securityRole: 'ADMIN',
      }),
    ).toThrow();
    expect(() =>
      db.jobs.list({ ...admin, organizationId: other.organizationId }, 'roles', {}),
    ).toThrow('ORGANIZATION_ADMIN_REQUIRED');
    expect(() =>
      db.jobs.save(other, 'families', { ...basic('Stolen'), version: 1 }, data.family.id),
    ).toThrow('JOB_RECORD_NOT_FOUND');
    expect(db.jobs.list(admin, 'roles', {}).total).toBe(1);
  });
  it('rejects circular reporting lines and archived dependencies', () => {
    const data = setup();
    const parent = db.jobs.save(admin, 'positions', data.position);
    const child = db.jobs.save(admin, 'positions', {
      ...data.position,
      ...basic('Junior-QA'),
      reportsToPositionId: parent.id,
    });
    expect(() =>
      db.jobs.save(
        admin,
        'positions',
        { ...data.position, reportsToPositionId: child.id, version: 1 },
        parent.id,
      ),
    ).toThrow('JOB_DEPENDENCY_CONFLICT');
    expect(() =>
      db.jobs.save(
        admin,
        'positions',
        { ...data.position, reportsToPositionId: parent.id, version: 1 },
        parent.id,
      ),
    ).toThrow('JOB_DEPENDENCY_CONFLICT');
    expect(() => db.jobs.archive(admin, 'positions', parent.id, 1)).toThrow(
      'JOB_DEPENDENCY_CONFLICT',
    );
    db.jobs.archive(admin, 'positions', child.id, 1);
    expect(() =>
      db.jobs.save(admin, 'positions', {
        ...data.position,
        ...basic('New'),
        reportsToPositionId: child.id,
      }),
    ).toThrow('JOB_DEPENDENCY_NOT_FOUND');
  });
  it('exposes authorized, strictly validated APIs with bounded server-side lists', async () => {
    const config: PasswordConfig = {
      mode: 'password',
      adminUrl: 'http://localhost:4200/',
      employeeUrl: 'http://localhost:4300/',
      secureCookies: false,
    };
    const app = createApp(db, config),
      token = randomBytes(32).toString('base64url');
    db.createSession(hashToken(token), LOCAL_ISSUER, admin.id, Date.now() + 60000);
    const cookie = `af_session=${token}`;
    await request(app).get('/api/organization/jobs/families').expect(401);
    const result = await request(app)
      .post('/api/organization/jobs/families')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send(basic('Engineering'))
      .expect(201);
    await request(app)
      .get('/api/organization/jobs/families?pageSize=1000')
      .set('Cookie', cookie)
      .expect(400);
    await request(app).get('/api/organization/jobs/identities').set('Cookie', cookie).expect(400);
    await request(app)
      .put(`/api/organization/jobs/families/${result.body.id}`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send({ ...basic('Updated'), version: 1 })
      .expect(200);
    await request(app)
      .post(`/api/organization/jobs/families/${result.body.id}/archive`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send({ version: 2 })
      .expect(204);
  });
});
