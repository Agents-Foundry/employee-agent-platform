import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GOOGLE_ISSUER, type GoogleConfig } from '../src/auth.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import type { IdentityEntry } from '../src/identity-directory.js';

const config: GoogleConfig = {
  mode: 'google',
  clientId: 'test',
  clientSecret: 'test',
  workspaceDomain: 'example.com',
  callbackUrl: 'http://localhost:4100/api/auth/callback',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const password = 'a long unique test passphrase';
describe('email and password authentication', () => {
  let db: ControlPlaneDatabase;
  let entry: IdentityEntry;
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword(password);
  });
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    entry = {
      subject: 'local:employee',
      employeeId: 'employee',
      organization: { id: 'org', name: 'Org', slug: 'org' },
      displayName: 'Employee',
      email: 'employee@example.com',
      role: 'EMPLOYEE',
      team: 'QA',
      passwordHash: hash,
    };
    db.syncIdentities(GOOGLE_ISSUER, [entry]);
  });
  afterEach(() => db.close());
  const login = (
    app: ReturnType<typeof createApp>,
    email = 'employee@example.com',
    supplied = password,
  ) =>
    request(app)
      .post('/api/auth/password')
      .set('Origin', 'http://localhost:4300')
      .send({ email, password: supplied });
  it('salts passwords, verifies exact values, and rejects weak or malformed credentials', async () => {
    expect(await hashPassword(password)).not.toBe(hash);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password + ' ', hash)).toBe(false);
    expect(await verifyPassword(password, 'plaintext')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('x'.repeat(257))).rejects.toThrow();
  });
  it('issues rotating HttpOnly sessions and retains server-assigned roles despite spoofed headers', async () => {
    const app = createApp(db, config);
    const first = await login(app, ' Employee@EXAMPLE.com ')
      .set('x-actor-role', 'ADMIN')
      .expect(200);
    expect(first.body).toEqual({ id: 'employee', organizationId: 'org', role: 'EMPLOYEE' });
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    expect(first.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(first.headers['set-cookie'][0]).toContain('SameSite=Lax');
    await request(app).get('/api/auth/session').set('Cookie', cookie).expect(200);
    await login(app).set('Cookie', cookie).expect(200);
    await request(app).get('/api/auth/session').set('Cookie', cookie).expect(401);
  });
  it('does not reveal unknown, disabled, Google-only, or incorrect-password accounts', async () => {
    const app = createApp(db, config);
    const wrong = await login(app, entry.email, 'incorrect').expect(401);
    expect((await login(app, 'unknown@example.com').expect(401)).body).toEqual(wrong.body);
    db.syncIdentities(GOOGLE_ISSUER, [{ ...entry, passwordHash: undefined }]);
    expect((await login(app).expect(401)).body).toEqual(wrong.body);
    db.syncIdentities(GOOGLE_ISSUER, []);
    expect((await login(app).expect(401)).body).toEqual(wrong.body);
  });
  it('rejects login CSRF and throttles repeated attempts', async () => {
    const app = createApp(db, config);
    await request(app)
      .post('/api/auth/password')
      .send({ email: entry.email, password })
      .expect(403);
    await request(app)
      .post('/api/auth/password')
      .set('Origin', 'https://evil.example')
      .send({ email: entry.email, password })
      .expect(403);
    for (let n = 0; n < 10; n++) await login(app, entry.email, '').expect(401);
    await login(app).expect(429);
  });
  it('revokes sessions when passwords rotate or are removed', async () => {
    const app = createApp(db, config);
    const first = await login(app).expect(200);
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const updated = { ...entry, passwordHash: await hashPassword('a different long passphrase') };
    db.syncIdentities(GOOGLE_ISSUER, [updated]);
    await request(app).get('/api/auth/session').set('Cookie', cookie).expect(401);
    await login(app).expect(401);
    const second = await login(app, entry.email, 'a different long passphrase').expect(200);
    db.syncIdentities(GOOGLE_ISSUER, [{ ...entry, passwordHash: undefined }]);
    await request(app)
      .get('/api/auth/session')
      .set('Cookie', second.headers['set-cookie'][0].split(';')[0])
      .expect(401);
  });
});
