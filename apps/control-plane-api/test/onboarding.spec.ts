import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadAuthConfig, hashToken, type PasswordConfig } from '../src/auth.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { activationUrl } from '../src/organization-routes.js';
import { hashPassword } from '../src/passwords.js';
import { testDatabase } from './support/database.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const password = 'a unique long onboarding passphrase';
describe('customer onboarding and organization membership', () => {
  let db: ControlPlaneDatabase;
  beforeEach(async () => {
    db = await testDatabase({ seedDemo: false });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });
  const customer = (slug: string) =>
    db.createCustomer(
      { name: slug, slug },
      { displayName: 'Admin', email: `admin@${slug}.example`, team: 'Administration' },
    );
  const activate = (app: ReturnType<typeof createApp>, token: string) =>
    request(app)
      .post('/api/auth/activate')
      .set('Origin', 'http://localhost:4200')
      .send({ token, password });
  const login = (app: ReturnType<typeof createApp>, email: string) =>
    request(app)
      .post('/api/auth/password')
      .set('Origin', 'http://localhost:4200')
      .send({ email, password });
  const sessionCookie = (response: request.Response) =>
    response.headers['set-cookie'][0].split(';')[0];

  it('runs password-only auth without Google configuration and rejects insecure production URLs', () => {
    expect(
      loadAuthConfig({
        AUTH_MODE: 'password',
        ADMIN_APP_URL: config.adminUrl,
        EMPLOYEE_APP_URL: config.employeeUrl,
      }),
    ).toEqual(config);
    expect(() =>
      loadAuthConfig({
        AUTH_MODE: 'password',
        NODE_ENV: 'production',
        ADMIN_APP_URL: config.adminUrl,
        EMPLOYEE_APP_URL: config.employeeUrl,
      }),
    ).toThrow();
    expect(() =>
      loadAuthConfig({
        AUTH_MODE: 'password',
        ADMIN_APP_URL: config.adminUrl,
        EMPLOYEE_APP_URL: 'http://127.0.0.1:4300/',
      }),
    ).toThrow();
    const url = new URL(activationUrl(config.adminUrl, 'private-token'));
    expect(url.search).toBe('');
    expect(url.hash).toBe('#activate=private-token');
  });

  it('activates the assigned first admin once without automatic login or public signup', async () => {
    const invitation = await customer('first');
    const app = createApp(db, config);
    await login(app, 'admin@first.example').expect(401);
    const activated = await activate(app, invitation.token).expect(204);
    expect(activated.headers['set-cookie']).toBeUndefined();
    await activate(app, invitation.token).expect(400);
    const signedIn = await login(app, 'admin@first.example').expect(200);
    expect(signedIn.body).toEqual({
      id: invitation.employeeId,
      organizationId: invitation.organizationId,
      role: 'ADMIN',
    });
    await request(app).post('/api/organization/invitations').expect(401);
    await request(app).get('/api/auth/login?client=admin').expect(404);
    expect((await request(app).get('/api/auth/config')).body).toEqual({ mode: 'password' });
  });

  it('isolates two organizations, rejects role injection, and immediately revokes disabled users', async () => {
    const a = await customer('alpha'),
      b = await customer('beta');
    const app = createApp(db, config);
    await activate(app, a.token).expect(204);
    await activate(app, b.token).expect(204);
    const adminA = sessionCookie(await login(app, 'admin@alpha.example').expect(200));
    const adminB = sessionCookie(await login(app, 'admin@beta.example').expect(200));
    const input = { displayName: 'Employee', email: 'employee@alpha.example', team: 'Engineering' };
    await request(app)
      .post('/api/organization/invitations')
      .set('Cookie', adminA)
      .set('Origin', 'http://localhost:4200')
      .send({ ...input, role: 'ADMIN' })
      .expect(400);
    const invitation = await request(app)
      .post('/api/organization/invitations')
      .set('Cookie', adminA)
      .set('Origin', 'http://localhost:4200')
      .send(input)
      .expect(201);
    const token = new URLSearchParams(new URL(invitation.body.activationUrl).hash.slice(1)).get(
      'activate',
    )!;
    await activate(app, token).expect(204);
    const employeeLogin = await login(app, input.email).expect(200);
    expect(employeeLogin.body.role).toBe('EMPLOYEE');
    expect(employeeLogin.body.organizationId).toBe(a.organizationId);
    const employeeCookie = sessionCookie(employeeLogin);
    await request(app).get('/api/organization/members').set('Cookie', employeeCookie).expect(403);
    const membersB = await request(app)
      .get('/api/organization/members')
      .set('Cookie', adminB)
      .expect(200);
    expect(membersB.body).toHaveLength(1);
    expect(JSON.stringify(membersB.body)).not.toContain(input.email);
    await request(app)
      .post(`/api/organization/members/${invitation.body.employeeId}/disable`)
      .set('Cookie', adminB)
      .set('Origin', 'http://localhost:4200')
      .expect(404);
    await request(app)
      .post(`/api/organization/members/${a.employeeId}/disable`)
      .set('Cookie', adminA)
      .set('Origin', 'http://localhost:4200')
      .expect(403);
    await request(app)
      .post(`/api/organization/members/${invitation.body.employeeId}/disable`)
      .set('Cookie', adminA)
      .set('Origin', 'http://localhost:4200')
      .expect(204);
    await request(app).get('/api/auth/session').set('Cookie', employeeCookie).expect(401);
    await login(app, input.email).expect(401);
    const audit = JSON.stringify(await db.listLifecycleEvents(a.organizationId));
    expect(audit).toContain('employee.disabled');
    expect(audit).not.toContain(token);
  }, 15000);

  it('rejects missing origins, short passwords, expired links and revoked pending invitations', async () => {
    const a = await customer('expiry');
    const app = createApp(db, config);
    await request(app).post('/api/auth/activate').send({ token: a.token, password }).expect(403);
    await request(app)
      .post('/api/auth/activate')
      .set('Origin', 'http://localhost:4200')
      .send({ token: a.token, password: 'short' })
      .expect(400);
    const hash = await hashPassword(password);
    const currentTime = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(currentTime + 49 * 3600000);
    expect(await db.acceptInvitation(hashToken(a.token), hash)).toBe(false);
    vi.restoreAllMocks();
    expect(await db.acceptInvitation(hashToken(a.token), hash)).toBe(true);
    const actor = { id: a.employeeId, organizationId: a.organizationId, role: 'ADMIN' as const };
    const pending = await db.inviteEmployee(actor, {
      displayName: 'Pending',
      email: 'pending@expiry.example',
      team: 'QA',
    });
    await db.disableMember(actor, pending.employeeId);
    expect(await db.acceptInvitation(hashToken(pending.token), hash)).toBe(false);
  });

  it('rolls back duplicate customer creation and prevents parallel activation replay', async () => {
    const a = await customer('unique');
    await expect(
      db.createCustomer(
        { name: 'Other', slug: 'other' },
        { email: 'ADMIN@UNIQUE.EXAMPLE', displayName: 'Collision', team: 'Admin' },
      ),
    ).rejects.toThrow('ACCOUNT_NOT_ACTIVE');
    await expect(customer('other')).resolves.not.toThrow();
    const app = createApp(db, config);
    const results = await Promise.all([activate(app, a.token), activate(app, a.token)]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 400]);
  });
});
