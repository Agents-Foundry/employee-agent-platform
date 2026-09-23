import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import type { AdminAgentInput } from '@agents-foundry/contracts';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { hashPassword } from '../src/passwords.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const secret = 'long and unique linked account password';
const origin = 'http://localhost:4200';
const sessionCookie = (response: request.Response) =>
  response.headers['set-cookie'][0].split(';')[0];

describe('verified account linking and tenant switching', () => {
  let db: ControlPlaneDatabase;
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword(secret);
  });
  afterEach(() => db?.close());

  it('requires the invited account, consumes the private link once and switches scoped sessions', async () => {
    db = new ControlPlaneDatabase(':memory:', false);
    const alpha = db.createCustomer(
      { name: 'Alpha', slug: 'alpha' },
      { displayName: 'Alex', email: 'alex@company.example', team: 'Admin' },
    );
    const beta = db.createCustomer(
      { name: 'Beta', slug: 'beta' },
      { displayName: 'Blair', email: 'blair@company.example', team: 'Admin' },
    );
    expect(db.acceptInvitation(hashToken(alpha.token), hash)).toBe(true);
    expect(db.acceptInvitation(hashToken(beta.token), hash)).toBe(true);
    const app = createApp(db, config);
    const signIn = (email: string) =>
      request(app)
        .post('/api/auth/password')
        .set('Origin', origin)
        .send({ email, password: secret });
    const alphaCookie = sessionCookie(await signIn('alex@company.example').expect(200));
    const betaCookie = sessionCookie(await signIn('blair@company.example').expect(200));
    const invitation = await request(app)
      .post('/api/organization/invitations')
      .set('Cookie', betaCookie)
      .set('Origin', origin)
      .send({ displayName: 'Alex in Beta', email: 'alex@company.example', team: 'Delivery' })
      .expect(201);
    expect(invitation.body.purpose).toBe('link');
    const token = new URL(invitation.body.activationUrl).hash.replace('#link=', '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      db.tenancy.listMemberships(
        { id: beta.employeeId, organizationId: beta.organizationId, role: 'ADMIN' },
        { search: 'alex' },
      ).items[0].membershipStatus,
    ).toBe('pending');
    await request(app)
      .get('/api/auth/link-preview')
      .query({ token })
      .set('Cookie', betaCookie)
      .expect(404);
    const preview = await request(app)
      .get('/api/auth/link-preview')
      .query({ token })
      .set('Cookie', alphaCookie)
      .expect(200);
    expect(preview.body.organizationId).toBe(beta.organizationId);
    await request(app)
      .post('/api/auth/link-account')
      .set('Origin', origin)
      .send({ token })
      .expect(401);
    const linked = await request(app)
      .post('/api/auth/link-account')
      .set('Origin', origin)
      .set('Cookie', alphaCookie)
      .send({ token })
      .expect(200);
    expect(linked.body).toEqual({
      id: invitation.body.employeeId,
      organizationId: beta.organizationId,
      role: 'EMPLOYEE',
    });
    const linkedCookie = sessionCookie(linked);
    const betaActor = {
      id: beta.employeeId,
      organizationId: beta.organizationId,
      role: 'ADMIN' as const,
    };
    const domain = db.tenancy.registerDomain(betaActor, {
      domain: 'portal.beta.example.org',
      domainType: 'custom_domain',
    });
    await db.tenancy.verifyDomain(betaActor, domain.id, async () => [[domain.verificationToken!]]);
    await request(app)
      .get('/api/auth/session')
      .set('Host', domain.domain)
      .set('Cookie', linkedCookie)
      .expect(200);
    await request(app)
      .get('/api/auth/session')
      .set('Host', domain.domain)
      .set('Cookie', alphaCookie)
      .expect(401);
    await request(app)
      .post('/api/auth/switch')
      .set('Host', domain.domain)
      .set('Origin', `https://${domain.domain}`)
      .set('Cookie', linkedCookie)
      .send({ organizationId: alpha.organizationId })
      .expect(403);
    await request(app).get('/api/auth/session').set('Cookie', alphaCookie).expect(401);
    await request(app)
      .post('/api/auth/link-account')
      .set('Origin', origin)
      .set('Cookie', linkedCookie)
      .send({ token })
      .expect(404);
    const memberships = await request(app)
      .get('/api/auth/memberships')
      .set('Cookie', linkedCookie)
      .expect(200);
    expect(
      memberships.body.map((item: { organizationId: string }) => item.organizationId).sort(),
    ).toEqual([alpha.organizationId, beta.organizationId].sort());
    const assignmentInput: AdminAgentInput = {
      requestId: randomUUID(),
      name: 'Linked QA',
      employeeIds: [invitation.body.employeeId],
      blueprintId: 'engineering.qa-engineer',
      blueprintVersion: '1.1.0',
      provider: 'test',
      model: 'test-model',
      credentialMode: 'ORGANIZATION_MANAGED',
      answers: {
        projectName: 'Linked pilot',
        repositoryUrl: 'https://example.com/repo',
        qaUrl: 'https://qa.example.com',
        issueTracker: ['Jira'],
        sourceControl: ['GitHub'],
        testingTechnologies: ['Playwright'],
      },
    };
    expect(db.createAssignedAgents(betaActor, assignmentInput)).toHaveLength(1);
    const employeeLogin = await request(app)
      .post('/api/auth/password')
      .set('Origin', origin)
      .send({ email: 'alex@company.example', password: secret, client: 'employee' })
      .expect(200);
    expect(employeeLogin.body).toEqual(linked.body);
    await request(app)
      .post('/api/auth/switch')
      .set('Origin', origin)
      .set('Cookie', linkedCookie)
      .send({ organizationId: '00000000-0000-4000-8000-000000000000' })
      .expect(403);
    const switched = await request(app)
      .post('/api/auth/switch')
      .set('Origin', origin)
      .set('Cookie', linkedCookie)
      .send({ organizationId: alpha.organizationId })
      .expect(200);
    expect(switched.body).toEqual({
      id: alpha.employeeId,
      organizationId: alpha.organizationId,
      role: 'ADMIN',
    });
    await request(app).get('/api/auth/session').set('Cookie', linkedCookie).expect(401);
    const switchedCookie = sessionCookie(switched);
    await request(app).get('/api/organization/profile').set('Cookie', switchedCookie).expect(200);
    const betaMembership = db.tenancy.listMemberships(
      { id: beta.employeeId, organizationId: beta.organizationId, role: 'ADMIN' },
      { search: 'alex' },
    ).items[0];
    db.tenancy.setMembershipStatus(
      { id: beta.employeeId, organizationId: beta.organizationId, role: 'ADMIN' },
      betaMembership.id,
      { status: 'suspended', version: betaMembership.version },
    );
    await request(app).get('/api/auth/session').set('Cookie', switchedCookie).expect(200);
    await request(app)
      .post('/api/auth/switch')
      .set('Origin', origin)
      .set('Cookie', switchedCookie)
      .send({ organizationId: beta.organizationId })
      .expect(403);
  });

  it('lets an operator invite an existing account as a second organization administrator', () => {
    db = new ControlPlaneDatabase(':memory:', false);
    const first = db.createCustomer(
      { name: 'First', slug: 'first' },
      { displayName: 'Owner', email: 'owner@example.org', team: 'Admin' },
    );
    db.acceptInvitation(hashToken(first.token), hash);
    const second = db.createCustomer(
      { name: 'Second', slug: 'second' },
      { displayName: 'Owner', email: 'owner@example.org', team: 'Admin' },
    );
    expect(second.purpose).toBe('link');
    expect(db.findPasswordAccount('owner@example.org')?.organizationId).toBe(first.organizationId);
    const firstUser = db.listAccountMemberships({
      id: first.employeeId,
      organizationId: first.organizationId,
      role: 'ADMIN',
    });
    expect(firstUser).toHaveLength(1);
    const userId = db.accountSessionUser('missing');
    expect(userId).toBeUndefined();
    const firstMembership = db.tenancy.listMemberships(
      { id: first.employeeId, organizationId: first.organizationId, role: 'ADMIN' },
      {},
    ).items[0];
    const linked = db.acceptAccountLink(hashToken(second.token), firstMembership.userId);
    expect(linked).toEqual({
      id: second.employeeId,
      organizationId: second.organizationId,
      role: 'ADMIN',
    });
    expect(db.tenancy.profile(linked!).name).toBe('Second');
  });

  it('does not link an account that has not completed its first activation', async () => {
    db = new ControlPlaneDatabase(':memory:', false);
    db.createCustomer(
      { name: 'Pending', slug: 'pending' },
      { displayName: 'Pat', email: 'pat@example.org', team: 'Admin' },
    );
    const active = db.createCustomer(
      { name: 'Active', slug: 'active' },
      { displayName: 'Owner', email: 'owner@example.org', team: 'Admin' },
    );
    db.acceptInvitation(hashToken(active.token), hash);
    const app = createApp(db, config);
    const cookie = sessionCookie(
      await request(app)
        .post('/api/auth/password')
        .set('Origin', origin)
        .send({ email: 'owner@example.org', password: secret })
        .expect(200),
    );
    await request(app)
      .post('/api/organization/invitations')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ displayName: 'Pat', email: 'pat@example.org', team: 'Team' })
      .expect(409, { error: 'ACCOUNT_NOT_ACTIVE' });
    expect(
      db.tenancy.listMemberships(
        { id: active.employeeId, organizationId: active.organizationId, role: 'ADMIN' },
        {},
      ).total,
    ).toBe(1);
  });
});
