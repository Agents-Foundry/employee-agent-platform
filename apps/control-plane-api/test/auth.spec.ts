import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import {
  GoogleSignIn,
  GOOGLE_ISSUER,
  hashToken,
  loadAuthConfig,
  type GoogleConfig,
} from '../src/auth.js';
import type { IdentityEntry } from '../src/identity-directory.js';
import { syncIdentityDirectory } from '../src/identity-directory.js';

const config: GoogleConfig = {
  mode: 'google',
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  workspaceDomain: 'example.com',
  callbackUrl: 'http://localhost:4100/api/auth/callback',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const member = (
  subject: string,
  employeeId: string,
  organizationId: string,
  role: 'ADMIN' | 'EMPLOYEE',
): IdentityEntry => ({
  subject,
  employeeId,
  organization: { id: organizationId, name: organizationId, slug: organizationId },
  displayName: employeeId,
  email: `${employeeId}@example.com`,
  role,
  team: 'QA',
});
const directory = [
  member('google-a', 'employee-a', 'org-a', 'EMPLOYEE'),
  member('google-peer', 'employee-peer', 'org-a', 'EMPLOYEE'),
  member('google-admin-a', 'admin-a', 'org-a', 'ADMIN'),
  member('google-b', 'employee-b', 'org-b', 'EMPLOYEE'),
  member('google-admin-b', 'admin-b', 'org-b', 'ADMIN'),
];
const provisioning = {
  blueprintId: 'engineering.qa-engineer',
  blueprintVersion: '1.1.0',
  provider: 'test',
  model: 'test',
  credentialMode: 'EMPLOYEE_BYOK' as const,
  answers: {
    projectName: 'Pilot',
    repositoryUrl: 'https://example.com/repo',
    qaUrl: 'https://qa.example.com',
    issueTracker: ['Jira'],
    sourceControl: ['GitHub'],
    testingTechnologies: ['Playwright'],
  },
};

describe('Google Workspace sessions and tenant authorization', () => {
  let db: ControlPlaneDatabase;
  let pair: Awaited<ReturnType<typeof generateKeyPair>>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    pair = await generateKeyPair('RS256');
    keys = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(pair.publicKey)), kid: 'google-test', alg: 'RS256', use: 'sig' },
      ],
    });
  });
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false);
    db.syncIdentities(GOOGLE_ISSUER, directory);
  });
  afterEach(() => db.close());

  async function token(nonce: string, overrides: JWTPayload = {}, signingKey = pair.privateKey) {
    return new SignJWT({
      sub: 'google-a',
      iss: GOOGLE_ISSUER,
      aud: config.clientId,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      nonce,
      hd: 'example.com',
      email_verified: true,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'google-test' })
      .sign(signingKey);
  }
  const provider = (idToken: () => Promise<string>) =>
    new GoogleSignIn(
      config,
      keys,
      vi.fn(
        async () => new Response(JSON.stringify({ id_token: await idToken() }), { status: 200 }),
      ) as typeof fetch,
    );
  function session(subject: string, expiresAt = Date.now() + 60000) {
    const value = randomBytes(32).toString('base64url');
    db.createSession(hashToken(value), GOOGLE_ISSUER, subject, expiresAt);
    return `af_session=${value}`;
  }
  function assignedAgent(employeeId: string, org: string, admin: string) {
    const pending = db.requestProvisioning(employeeId, provisioning, org);
    return manifestSubject(
      db.decideProvisioning(pending.id, org, admin, 'APPROVED', 'Pilot').manifest!.payload,
    ).agentId;
  }

  it('binds a one-use callback to the browser, validates Google identity, and issues an HttpOnly session', async () => {
    let nonce = '';
    let challenge = '';
    const outbound = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init!.body as URLSearchParams;
      expect(body.get('client_secret')).toBe(config.clientSecret);
      expect(body.get('redirect_uri')).toBe(config.callbackUrl);
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        challenge,
      );
      return new Response(JSON.stringify({ id_token: await token(nonce) }), { status: 200 });
    });
    const app = createApp(db, config, new GoogleSignIn(config, keys, outbound as typeof fetch));
    const browser = request.agent(app);
    const login = await browser.get('/api/auth/login?client=employee').expect(302);
    const url = new URL(login.headers['location']);
    nonce = url.searchParams.get('nonce')!;
    challenge = url.searchParams.get('code_challenge')!;
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = `/api/auth/callback?state=${url.searchParams.get('state')}&code=test-code`;
    await request(app).get(callback).expect(400);
    const result = await browser.get(callback).expect(302);
    expect(result.headers['location']).toBe(config.employeeUrl);
    const cookies = result.headers['set-cookie'] as unknown as string[];
    expect(
      cookies.some(
        (value) =>
          value.startsWith('af_session=') &&
          value.includes('HttpOnly') &&
          value.includes('SameSite=Lax'),
      ),
    ).toBe(true);
    const identity = await browser
      .get('/api/auth/session')
      .set('x-actor-role', 'ADMIN')
      .set('x-organization-id', 'org-b')
      .expect(200);
    expect(identity.body).toEqual({ id: 'employee-a', organizationId: 'org-a', role: 'EMPLOYEE' });
    await browser.get(callback).expect(400);
    expect(outbound).toHaveBeenCalledTimes(1);
    await browser
      .post('/api/auth/logout')
      .set('Origin', config.employeeUrl.slice(0, -1))
      .expect(204);
    await browser.get('/api/bootstrap').expect(401);
  });

  it('rejects bad signatures, expired tokens, wrong issuer/audience/nonce/domain, personal accounts and unverified email', async () => {
    const variants: JWTPayload[] = [
      { iss: 'https://attacker.example' },
      { aud: 'other-client' },
      { aud: [config.clientId, 'other-client'] },
      { exp: undefined },
      { exp: 1 },
      { nonce: 'other' },
      { hd: 'attacker.example' },
      { hd: undefined },
      { email_verified: false },
      { azp: 'other-client' },
      { iat: Date.now() / 1000 + 1000 },
    ];
    for (const claims of variants)
      await expect(
        provider(() => token('expected', claims)).exchange('code', 'verifier', 'expected'),
      ).rejects.toBeDefined();
    const wrongPair = await generateKeyPair('RS256');
    await expect(
      provider(() => token('expected', {}, wrongPair.privateKey)).exchange(
        'code',
        'verifier',
        'expected',
      ),
    ).rejects.toBeDefined();
  });

  it('rejects mismatched or expired state and unlisted Workspace accounts', async () => {
    let nonce = '';
    const app = createApp(
      db,
      config,
      provider(() => token(nonce, { sub: 'unlisted-google-sub' })),
    );
    const browser = request.agent(app);
    let login = await browser.get('/api/auth/login?client=admin').expect(302);
    await browser.get('/api/auth/callback?state=wrong&code=code').expect(400);
    login = await browser.get('/api/auth/login?client=employee').expect(302);
    const url = new URL(login.headers['location']);
    nonce = url.searchParams.get('nonce')!;
    await browser
      .get(`/api/auth/callback?state=${url.searchParams.get('state')}&code=code`)
      .expect(403);
    await browser.get('/api/auth/session').expect(401);
    const binding = randomBytes(32).toString('base64url');
    db.createLogin(
      hashToken(binding),
      { state: 'old', nonce: 'nonce', verifier: 'verifier', destination: config.employeeUrl },
      1,
    );
    await request(app)
      .get('/api/auth/callback?state=old&code=code')
      .set('Cookie', `af_login=${binding}`)
      .expect(400);
  });

  it('protects all business routes, forbids forged identities and agent-authored messages, and enforces CSRF checks', async () => {
    const app = createApp(db, config);
    for (const path of [
      '/api/bootstrap',
      '/api/blueprints',
      '/api/provisioning',
      '/api/approvals',
      '/api/lifecycle-events',
      '/api/conversations',
      '/api/manifest-key',
    ])
      await request(app).get(path).set('x-actor-role', 'ADMIN').expect(401);
    const cookie = session('google-a');
    await request(app)
      .post('/api/provisioning')
      .set('Cookie', cookie)
      .send(provisioning)
      .expect(403);
    await request(app)
      .post('/api/provisioning')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(provisioning)
      .expect(403);
    const created = await request(app)
      .post('/api/provisioning')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4300')
      .send(provisioning)
      .expect(201);
    await request(app)
      .post(`/api/provisioning/${created.body.id}/decision`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4300')
      .set('x-actor-role', 'ADMIN')
      .send({ decision: 'APPROVED', reason: 'spoof' })
      .expect(403);
    await request(app)
      .post('/api/conversations/x/messages')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:4300')
      .send({ author: 'AGENT', content: 'spoof' })
      .expect(403);
    await request(app)
      .get('/api/conversations?employeeId=employee-b')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('isolates conversations, agents, approvals, provisioning, and audit across organizations and peers', async () => {
    const app = createApp(db, config);
    const agentA = assignedAgent('employee-a', 'org-a', 'admin-a');
    const agentB = assignedAgent('employee-b', 'org-b', 'admin-b');
    const a = session('google-a'),
      peer = session('google-peer'),
      b = session('google-b'),
      adminB = session('google-admin-b');
    const conversation = await request(app)
      .post('/api/conversations')
      .set('Cookie', a)
      .set('Origin', 'http://localhost:4300')
      .send({ employeeId: 'employee-a', agentId: agentA, title: 'Private QA' })
      .expect(201);
    const run = await request(app)
      .post('/api/qa/runs')
      .set('Cookie', a)
      .set('Origin', 'http://localhost:4300')
      .send({
        employeeId: 'employee-a',
        conversationId: conversation.body.id,
        storyKey: 'QA-123',
        targetUrl: 'https://qa.example.com',
      })
      .expect(202);
    for (const foreign of [b, peer, adminB]) {
      await request(app)
        .get(`/api/conversations/${conversation.body.id}`)
        .set('Cookie', foreign)
        .expect(404);
      await request(app).get(`/api/agents/${agentA}/manifest`).set('Cookie', foreign).expect(404);
    }
    await request(app)
      .post('/api/conversations')
      .set('Cookie', b)
      .set('Origin', 'http://localhost:4300')
      .send({ employeeId: 'employee-b', agentId: agentA, title: 'Cross tenant' })
      .expect(404);
    await request(app)
      .post(`/api/approvals/${run.body.approval.id}/decision`)
      .set('Cookie', adminB)
      .set('Origin', 'http://localhost:4200')
      .send({ decision: 'APPROVED' })
      .expect(404);
    expect(
      (await request(app).get('/api/approvals').set('Cookie', adminB).expect(200)).body,
    ).toEqual([]);
    const bootstrap = (await request(app).get('/api/bootstrap').set('Cookie', b).expect(200)).body;
    expect(bootstrap.organization.id).toBe('org-b');
    expect(bootstrap.employee.id).toBe('employee-b');
    expect(bootstrap.agents.map((agent: { id: string }) => agent.id)).toEqual([agentB]);
    const requests = (await request(app).get('/api/provisioning').set('Cookie', adminB).expect(200))
      .body;
    expect(
      requests.every((item: { organizationId: string }) => item.organizationId === 'org-b'),
    ).toBe(true);
    const events = (
      await request(app).get('/api/lifecycle-events').set('Cookie', adminB).expect(200)
    ).body;
    expect(events).toHaveLength(3);
    expect(
      events.every((item: { organizationId: string }) => item.organizationId === 'org-b'),
    ).toBe(true);
  });

  it('expires sessions and applies membership removal or role changes on the next request', async () => {
    const app = createApp(db, config);
    const cookie = session('google-admin-a');
    await request(app).get('/api/lifecycle-events').set('Cookie', cookie).expect(200);
    db.syncIdentities(
      GOOGLE_ISSUER,
      directory.map((entry) =>
        entry.subject === 'google-admin-a' ? { ...entry, role: 'EMPLOYEE' } : entry,
      ),
    );
    await request(app).get('/api/lifecycle-events').set('Cookie', cookie).expect(403);
    db.syncIdentities(
      GOOGLE_ISSUER,
      directory.filter((entry) => entry.subject !== 'google-admin-a'),
    );
    await request(app).get('/api/auth/session').set('Cookie', cookie).expect(401);
    db.syncIdentities(GOOGLE_ISSUER, directory);
    await request(app).get('/api/auth/session').set('Cookie', cookie).expect(401);
    await request(app).get('/api/auth/session').set('Cookie', session('google-a', 1)).expect(401);
  });

  it('fails startup on missing configuration and production demo authentication', () => {
    expect(() => loadAuthConfig({})).toThrow();
    expect(() => loadAuthConfig({ AUTH_MODE: 'demo', NODE_ENV: 'production' })).toThrow(
      'DEMO_AUTH_FORBIDDEN_IN_PRODUCTION',
    );
    expect(loadAuthConfig({ AUTH_MODE: 'demo' })).toEqual({ mode: 'demo' });
  });

  it('validates deployment configuration and uses secure production cookie names', async () => {
    const environment = {
      AUTH_MODE: 'google',
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_CLIENT_SECRET: config.clientSecret,
      GOOGLE_WORKSPACE_DOMAIN: 'example.com',
      GOOGLE_CALLBACK_URL: 'https://agents.example.com/api/auth/callback',
      ADMIN_APP_URL: 'https://agents.example.com/admin/',
      EMPLOYEE_APP_URL: 'https://agents.example.com/employee/',
    };
    const production = loadAuthConfig(environment);
    expect(production.mode).toBe('google');
    const login = await request(createApp(db, production))
      .get('/api/auth/login?client=admin')
      .expect(302);
    expect((login.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /^__Host-af_login=.*Secure/,
    );
    expect(() =>
      loadAuthConfig({
        ...environment,
        GOOGLE_CALLBACK_URL: 'http://localhost:4100/api/auth/callback',
      }),
    ).toThrow();
    expect(() =>
      loadAuthConfig({ ...environment, ADMIN_APP_URL: 'https://other.example/admin/' }),
    ).toThrow('AUTH_URL_HOSTS_MUST_MATCH');
    expect(() => loadAuthConfig({ ...environment, GOOGLE_CLIENT_SECRET: '' })).toThrow();
  });

  it('validates the operator directory and preserves membership on invalid reassignment', () => {
    const folder = mkdtempSync(join(tmpdir(), 'agents-foundry-directory-'));
    const path = join(folder, 'members.json');
    try {
      writeFileSync(path, JSON.stringify(directory));
      syncIdentityDirectory(db, GOOGLE_ISSUER, path);
      expect(db.findIdentity(GOOGLE_ISSUER, 'google-a')?.organizationId).toBe('org-a');
      writeFileSync(path, JSON.stringify([directory[0], directory[0]]));
      expect(() => syncIdentityDirectory(db, GOOGLE_ISSUER, path)).toThrow('DUPLICATE_IDENTITY');
      writeFileSync(path, JSON.stringify([{ ...directory[0], role: 'OWNER' }]));
      expect(() => syncIdentityDirectory(db, GOOGLE_ISSUER, path)).toThrow();
      writeFileSync(
        path,
        JSON.stringify([{ ...directory[0], organization: directory[3].organization }]),
      );
      expect(() => syncIdentityDirectory(db, GOOGLE_ISSUER, path)).toThrow(
        'IDENTITY_REASSIGNMENT_FORBIDDEN',
      );
      expect(db.findIdentity(GOOGLE_ISSUER, 'google-a')?.organizationId).toBe('org-a');
      writeFileSync(path, '[]');
      syncIdentityDirectory(db, GOOGLE_ISSUER, path);
      expect(db.findIdentity(GOOGLE_ISSUER, 'google-a')).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('persists only hashed sessions and continues authentication after an API restart', () => {
    const folder = mkdtempSync(join(tmpdir(), 'agents-foundry-session-'));
    const path = join(folder, 'sessions.db');
    let database: ControlPlaneDatabase | undefined;
    const value = randomBytes(32).toString('base64url');
    try {
      database = new ControlPlaneDatabase(path, false);
      database.syncIdentities(GOOGLE_ISSUER, directory);
      database.createSession(hashToken(value), GOOGLE_ISSUER, 'google-a', Date.now() + 60000);
      database.close();
      database = new ControlPlaneDatabase(path, false);
      expect(database.findSession(hashToken(value))?.id).toBe('employee-a');
      expect(database.findSession(value)).toBeUndefined();
    } finally {
      database?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
