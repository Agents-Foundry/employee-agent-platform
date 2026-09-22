import request from 'supertest';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import type { Actor } from '@agents-foundry/contracts';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const oldPassword = 'unique original long password';
const newPassword = 'different replacement passphrase';
describe('invitation reissue and password recovery', () => {
  let db: ControlPlaneDatabase, admin: Actor, employeeId: string, initialToken: string;
  let oldHash: string, newHash: string;
  beforeAll(async () => {
    oldHash = await hashPassword(oldPassword);
    newHash = await hashPassword(newPassword);
  });
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    const customer = db.createCustomer(
      { name: 'Alpha', slug: 'alpha' },
      { displayName: 'Admin', email: 'admin@alpha.example', team: 'Admin' },
    );
    db.acceptInvitation(hashToken(customer.token), oldHash);
    admin = { id: customer.employeeId, organizationId: customer.organizationId, role: 'ADMIN' };
    const employee = db.inviteEmployee(admin, {
      displayName: 'Employee',
      email: 'employee@alpha.example',
      team: 'QA',
    });
    employeeId = employee.employeeId;
    initialToken = employee.token;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const session = (actor: Actor) => {
    const token = 'a'.repeat(43);
    db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
    return `af_session=${token}`;
  };
  const issue = (
    app: ReturnType<typeof createApp>,
    cookie: string,
    id: string,
    purpose: 'activate' | 'reset',
  ) =>
    request(app)
      .post(`/api/organization/members/${id}/recovery-link`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4200')
      .send({ purpose });
  const reset = (app: ReturnType<typeof createApp>, token: string) =>
    request(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'http://localhost:4300')
      .send({ token, password: newPassword });

  it('reissues expired invitations, consumes previous links, and preserves assigned membership', () => {
    const before = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(before + 49 * 3600000);
    expect(
      db.listMembers(admin.organizationId).find((member) => member['id'] === employeeId)?.[
        'status'
      ],
    ).toBe('INVITATION_EXPIRED');
    const replacement = db.issueEmployeeLink(admin, employeeId, 'activate');
    expect(replacement.expiresAt).toBe(Date.now() + 48 * 3600000);
    expect(db.acceptInvitation(hashToken(initialToken), oldHash)).toBe(false);
    expect(db.acceptInvitation(hashToken(replacement.token), oldHash)).toBe(true);
    expect(db.findIdentity(LOCAL_ISSUER, employeeId)).toEqual({
      id: employeeId,
      organizationId: admin.organizationId,
      role: 'EMPLOYEE',
    });
    expect(() => db.issueEmployeeLink(admin, employeeId, 'activate')).toThrow(
      'RECOVERY_STATE_CONFLICT',
    );
  });

  it('lets an operator recover an expired first-admin invitation without creating another organization', () => {
    const customer = db.createCustomer(
      { name: 'Beta', slug: 'beta' },
      { displayName: 'Admin', email: 'admin@beta.example', team: 'Admin' },
    );
    const replacement = db.issueOperatorLink(
      customer.organizationId,
      customer.employeeId,
      'activate',
    );
    expect(replacement.role).toBe('ADMIN');
    expect(db.acceptInvitation(hashToken(customer.token), oldHash)).toBe(false);
    expect(db.acceptInvitation(hashToken(replacement.token), oldHash)).toBe(true);
    const recovery = db.issueOperatorLink(customer.organizationId, customer.employeeId, 'reset');
    expect(db.resetPassword(hashToken(recovery.token), newHash)).toBe(true);
    expect(db.listMembers(customer.organizationId)).toHaveLength(1);
  });

  it('rejects employee callers, self/admin targets, foreign organizations and origin-less requests', async () => {
    const app = createApp(db, config),
      adminCookie = session(admin);
    await issue(app, adminCookie, admin.id, 'reset').expect(403);
    const other = db.createCustomer(
      { name: 'Other', slug: 'other' },
      { displayName: 'Other', email: 'admin@other.example', team: 'Admin' },
    );
    await issue(app, adminCookie, other.employeeId, 'activate').expect(404);
    await request(app)
      .post(`/api/organization/members/${employeeId}/recovery-link`)
      .set('Cookie', adminCookie)
      .send({ purpose: 'activate' })
      .expect(403);
    await issue(app, adminCookie, employeeId, 'reset').expect(409);
    db.acceptInvitation(hashToken(initialToken), oldHash);
    db.createSession(hashToken('b'.repeat(43)), LOCAL_ISSUER, employeeId, Date.now() + 3600000);
    await issue(app, `af_session=${'b'.repeat(43)}`, employeeId, 'reset').expect(403);
  });

  it('rotates reset links, retains sessions until redemption, then revokes every session and old password', async () => {
    db.acceptInvitation(hashToken(initialToken), oldHash);
    const app = createApp(db, config),
      adminCookie = session(admin);
    const employeeToken = 'c'.repeat(43);
    db.createSession(hashToken(employeeToken), LOCAL_ISSUER, employeeId, Date.now() + 3600000);
    db.createSession(hashToken('d'.repeat(43)), LOCAL_ISSUER, employeeId, Date.now() + 3600000);
    const first = db.issueEmployeeLink(admin, employeeId, 'reset');
    const response = await issue(app, adminCookie, employeeId, 'reset').expect(201);
    const url = new URL(response.body.activationUrl);
    expect(url.search).toBe('');
    const token = new URLSearchParams(url.hash.slice(1)).get('reset')!;
    expect(db.findSession(hashToken(employeeToken))).toBeDefined();
    await reset(app, first.token).expect(400);
    const result = await reset(app, token).expect(204);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(db.findSession(hashToken(employeeToken))).toBeUndefined();
    expect(db.findSession(hashToken('d'.repeat(43)))).toBeUndefined();
    await reset(app, token).expect(400);
    await request(app)
      .post('/api/auth/password')
      .set('Origin', 'http://localhost:4300')
      .send({ email: 'employee@alpha.example', password: oldPassword })
      .expect(401);
    await request(app)
      .post('/api/auth/password')
      .set('Origin', 'http://localhost:4300')
      .send({ email: 'employee@alpha.example', password: newPassword })
      .expect(200);
    const audit = JSON.stringify(db.listLifecycleEvents(admin.organizationId));
    expect(audit).toContain('employee.password_reset.completed');
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(newPassword);
  });

  it('rejects expired, cross-purpose and disabled-account recovery links', () => {
    expect(db.resetPassword(hashToken(initialToken), newHash)).toBe(false);
    db.acceptInvitation(hashToken(initialToken), oldHash);
    const link = db.issueEmployeeLink(admin, employeeId, 'reset');
    expect(db.acceptInvitation(hashToken(link.token), newHash)).toBe(false);
    const before = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(before + 3600001);
    expect(db.resetPassword(hashToken(link.token), newHash)).toBe(false);
    vi.restoreAllMocks();
    db.disableMember(admin, employeeId);
    expect(db.resetPassword(hashToken(link.token), newHash)).toBe(false);
    expect(() => db.issueEmployeeLink(admin, employeeId, 'reset')).toThrow(
      'RECOVERY_STATE_CONFLICT',
    );
    expect(() => db.issueEmployeeLink(admin, employeeId, 'activate')).toThrow(
      'RECOVERY_STATE_CONFLICT',
    );
  });

  it('does not re-enable an unactivated employee disabled by the admin', () => {
    db.disableMember(admin, employeeId);
    expect(() => db.issueEmployeeLink(admin, employeeId, 'activate')).toThrow(
      'RECOVERY_STATE_CONFLICT',
    );
    expect(db.acceptInvitation(hashToken(initialToken), oldHash)).toBe(false);
  });

  it('throttles link issuance and permits only one concurrent reset redemption', async () => {
    db.acceptInvitation(hashToken(initialToken), oldHash);
    const app = createApp(db, config),
      cookie = session(admin);
    for (let n = 0; n < 10; n++) await issue(app, cookie, employeeId, 'reset').expect(201);
    await issue(app, cookie, employeeId, 'reset').expect(429);
    const link = db.issueEmployeeLink(admin, employeeId, 'reset');
    const results = await Promise.all([reset(app, link.token), reset(app, link.token)]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 400]);
  });
});
