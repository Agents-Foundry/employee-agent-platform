/**
 * Alert webhooks (ADR 0024): endpoint administration, the delivery outbox, signing, retries,
 * and the outbound network guards, which are tested against real sockets.
 */
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Actor,
  AlertWebhook,
  AlertWebhookList,
  OrganizationModelBudget,
  WebhookEvent,
} from '@agents-foundry/contracts';
import { WEBHOOK_HEADERS, webhookSigningInput } from '../../../packages/contracts/src/webhooks.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import type { ControlPlaneDatabase } from '../src/database.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { hashPassword } from '../src/passwords.js';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from '../src/webhooks/alert-webhook-service.js';
import {
  guardedLookup,
  isBlockedAddress,
  webhookTransport,
  type WebhookSend,
} from '../src/webhooks/webhook-transport.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

describe('webhook network guards', () => {
  it('blocks private, loopback, link-local, shared, reserved and translated addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'not-an-address',
    ])
      expect(isBlockedAddress(address), address).toBe(true);
    for (const address of [
      '93.184.216.34',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '::ffff:93.184.216.34',
    ])
      expect(isBlockedAddress(address), address).toBe(false);
  });

  it('refuses a host name that resolves to a blocked address', async () => {
    const code = await new Promise((resolve) =>
      guardedLookup('localhost', {}, (error) => resolve((error as { code?: string })?.code)),
    );
    expect(code).toBe('WEBHOOK_ADDRESS_BLOCKED');
    // End to end: the connection is refused before any byte is sent.
    await expect(
      webhookTransport({ allowPrivateNetwork: false })('https://localhost/hook', {}, '{}', 2000),
    ).rejects.toMatchObject({ code: 'WEBHOOK_ADDRESS_BLOCKED' });
    await expect(
      webhookTransport({ allowPrivateNetwork: false })('http://example.com/hook', {}, '{}', 2000),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_INVALID' });
    // Address literals skip the lookup, so they are checked directly.
    for (const literal of [
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/',
    ])
      await expect(
        webhookTransport({ allowPrivateNetwork: false })(literal, {}, '{}', 2000),
      ).rejects.toMatchObject({ code: 'WEBHOOK_ADDRESS_BLOCKED' });
  });

  describe('against a local receiver', () => {
    let server: Server;
    let received: { headers: IncomingHttpHeaders; body: string }[];
    let respond: (res: import('node:http').ServerResponse) => void;
    beforeEach(async () => {
      received = [];
      respond = (res) => res.writeHead(204).end();
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          respond(res);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    afterEach(() => new Promise((resolve) => server.close(resolve)));
    const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

    it('posts the body with its headers and reports the status', async () => {
      const send = webhookTransport({ allowPrivateNetwork: true });
      expect(await send(url(), { 'x-test': '1' }, '{"a":1}', 2000)).toEqual({ status: 204 });
      expect(received).toHaveLength(1);
      expect(received[0]!.body).toBe('{"a":1}');
      expect(received[0]!.headers).toMatchObject({ 'x-test': '1', 'content-length': '7' });
      // Redirects are reported, never followed.
      respond = (res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      expect(await send(url(), {}, '{}', 2000)).toEqual({ status: 302 });
      expect(received).toHaveLength(2);
    });

    it('gives up at the deadline', async () => {
      respond = () => undefined;
      await expect(
        webhookTransport({ allowPrivateNetwork: true })(url(), {}, '{}', 200),
      ).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) });
    });
  });
});

describe('alert webhooks', () => {
  const config: PasswordConfig = {
    mode: 'password',
    adminUrl: 'http://localhost:4200/',
    employeeUrl: 'http://localhost:4300/',
    secureCookies: false,
  };
  let hash: string;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: Actor, otherAdmin: Actor, employee: Actor;
  const sessions = new Map<string, string>();
  let sent: { url: string; headers: Record<string, string>; body: string }[];
  let responses: (number | Error)[];
  const send: WebhookSend = async (url, headers, body) => {
    sent.push({ url, headers, body });
    const next = responses.shift() ?? 204;
    if (next instanceof Error) throw next;
    return { status: next };
  };

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });
  async function open(enabled = true) {
    db = await testDatabase({ seedDemo: false, alertWebhooks: enabled, webhookSend: send });
    app = createApp(db, config);
    const tenant = async (name: string) => {
      const created = await db.createCustomer(
        { name, slug: name.toLowerCase() },
        { displayName: 'Admin', email: `admin@${name}.example`, team: 'Admin' },
      );
      await db.acceptInvitation(hashToken(created.token), hash);
      return {
        id: created.employeeId,
        organizationId: created.organizationId,
        role: 'ADMIN' as const,
      };
    };
    admin = await tenant('Alpha');
    otherAdmin = await tenant('Beta');
    const invitation = await db.inviteEmployee(admin, {
      displayName: 'Quinn',
      email: 'quinn@alpha.example',
      team: 'QA',
    });
    await db.acceptInvitation(hashToken(invitation.token), hash);
    employee = {
      id: invitation.employeeId,
      organizationId: admin.organizationId,
      role: 'EMPLOYEE',
    };
    sessions.clear();
    for (const actor of [admin, otherAdmin, employee]) {
      const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
      await db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
      sessions.set(actor.id, `af_session=${token}`);
    }
  }
  beforeEach(async () => {
    sent = [];
    responses = [];
    await open();
  });
  afterEach(() => db.close());

  const call = (method: 'get' | 'put' | 'post', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](`/api/organization/alert-webhooks${path}`)
      .set('Cookie', sessions.get(actor.id)!)
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };
  const register = async (url: string, actor = admin) =>
    (await call('post', '', actor, { url, description: 'Finance alerts' }).expect(201))
      .body as AlertWebhook;
  const budget = (limit: number): OrganizationModelBudget => ({
    monthlyTokenLimit: limit,
    runTokenLimit: null,
    currency: 'USD',
    monthlyCostLimitMicros: null,
    runCostLimitMicros: null,
    alertThresholdsPercent: [80],
    version: 1,
    updatedBy: admin.id,
    updatedAt: new Date().toISOString(),
  });
  /** Raises the 80% token alert for the organization, as a reservation would. */
  const raise = (organizationId = admin.organizationId, period = '2026-09') =>
    db.store.tenant(organizationId, () =>
      db.modelSpending.alerts.check({
        organizationId,
        actorId: 'runtime-a',
        period,
        budget: budget(1000),
        charged: { tokens: 850, cost: 0 },
        nowMs: Date.now(),
      }),
    );
  const deliveries = () =>
    rawSql(db)
      .prepare(
        'SELECT status, attempts, last_status_code, last_error, next_attempt_at FROM alert_webhook_deliveries ORDER BY seq',
      )
      .all();
  /** A dispatch clock just after the test's deliveries were queued. */
  let now: number;
  beforeEach(() => {
    now = Date.now() + 60_000;
  });

  it('accepts only HTTPS on the default port to public host names, and never returns the full URL', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://10.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://intranet/x',
      'https://billing.internal/x',
      'https://hooks.example.com:8443/x',
      'https://user:pass@hooks.example.com/x',
      'https://hooks.example.com/x#fragment',
      'ftp://hooks.example.com/x',
      'not a url',
    ])
      await call('post', '', admin, { url, description: '' }).expect(400, {
        error: 'ALERT_WEBHOOK_URL_INVALID',
      });
    const secretUrl = 'https://hooks.example.com/services/T0123/B0456/s3cr3tT0k3n?sig=zz12';
    const created = await register(secretUrl);
    expect(created).toMatchObject({
      displayUrl: 'https://hooks.example.com/…zz12',
      description: 'Finance alerts',
      status: 'ACTIVE',
      version: 1,
      createdBy: admin.id,
    });
    const list = (await call('get', '', admin).expect(200)).body as AlertWebhookList;
    expect(list.webhooks).toEqual([created]);
    expect(list.signingKey).toEqual(db.signer.verificationKey);
    const events = await rawSql(db)
      .prepare(
        "SELECT after_json FROM organization_change_events WHERE resource_type='alert_webhook'",
      )
      .all<{ after_json: string }>();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(list) + events[0]!.after_json).not.toContain('s3cr3tT0k3n');
  });

  it('delivers each alert once to every active endpoint, signed with the pinned key', async () => {
    const first = await register('https://hooks.example.com/a');
    const second = await register('https://alerts.example.org/b');
    await call('put', `/${second.id}`, admin, { status: 'DISABLED', version: 1 }).expect(200);
    await register('https://hooks.example.com/theirs', otherAdmin);
    await raise();
    await raise(); // the same alert is not raised twice
    expect(await deliveries()).toHaveLength(1);
    expect(await db.alertWebhooks.dispatchDue(now)).toBe(1);
    expect(sent).toHaveLength(1);
    const [delivery] = sent;
    expect(delivery!.url).toBe('https://hooks.example.com/a');
    const id = delivery!.headers[WEBHOOK_HEADERS.id]!;
    const timestamp = Number(delivery!.headers[WEBHOOK_HEADERS.timestamp]);
    expect(timestamp).toBe(Math.floor(now / 1000));
    expect(delivery!.headers[WEBHOOK_HEADERS.keyId]).toBe(db.signer.verificationKey.keyId);
    const signature = delivery!.headers[WEBHOOK_HEADERS.signature]!;
    expect(signature).toMatch(/^ed25519=/);
    const key = createPublicKey({
      key: Buffer.from(db.signer.verificationKey.publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const signed = Buffer.from(webhookSigningInput(id, timestamp, delivery!.body));
    const bytes = Buffer.from(signature.slice('ed25519='.length), 'base64');
    expect(verify(null, signed, key, bytes)).toBe(true);
    // A changed body or a replayed timestamp does not verify.
    expect(
      verify(null, Buffer.from(webhookSigningInput(id, timestamp + 1, delivery!.body)), key, bytes),
    ).toBe(false);
    const event = JSON.parse(delivery!.body) as WebhookEvent;
    expect(event).toMatchObject({
      type: 'model.budget.alert',
      deliveryId: id,
      organizationId: admin.organizationId,
      data: {
        alert: { scope: 'MONTHLY_TOKENS', thresholdPercent: 80, limit: 1000, charged: 850 },
      },
    });
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'DELIVERED', attempts: 1, last_status_code: 204 }),
    ]);
    expect(await db.alertWebhooks.dispatchDue(now + 3_600_000)).toBe(0);
    const list = (await call('get', '', admin).expect(200)).body as AlertWebhookList;
    expect(list.deliveries).toEqual([
      expect.objectContaining({
        webhookId: first.id,
        eventType: 'model.budget.alert',
        status: 'DELIVERED',
      }),
    ]);
    // The other organization's endpoint received nothing, and its admin sees no deliveries.
    expect(
      ((await call('get', '', otherAdmin).expect(200)).body as AlertWebhookList).deliveries,
    ).toEqual([]);
  });

  it('retries timeouts and server errors with backoff, then fails and audits', async () => {
    await register('https://hooks.example.com/a');
    await raise();
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    responses = [503, timeout, 429, 500, 502, 503];
    let at = now;
    expect(await db.alertWebhooks.dispatchDue(at)).toBe(1);
    expect(await deliveries()).toEqual([
      {
        status: 'PENDING',
        attempts: 1,
        last_status_code: 503,
        last_error: 'WEBHOOK_HTTP_503',
        next_attempt_at: new Date(at + RETRY_DELAYS_MS[0]!).toISOString(),
      },
    ]);
    // Not before its time.
    expect(await db.alertWebhooks.dispatchDue(at + RETRY_DELAYS_MS[0]! - 1)).toBe(0);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      at += RETRY_DELAYS_MS[attempt - 1]!;
      expect(await db.alertWebhooks.dispatchDue(at)).toBe(1);
    }
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        attempts: 6,
        last_error: 'WEBHOOK_HTTP_503',
        next_attempt_at: null,
      }),
    ]);
    const bodies = new Set(sent.map((attempt) => attempt.body));
    const ids = new Set(sent.map((attempt) => attempt.headers[WEBHOOK_HEADERS.id]));
    expect([sent.length, bodies.size, ids.size]).toEqual([6, 1, 1]);
    const audit = await rawSql(db)
      .prepare(
        "SELECT actor_id, metadata FROM audit_events WHERE event_type='alert.webhook.failed'",
      )
      .all<{ actor_id: string; metadata: string }>();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe('control-plane');
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({
      attempts: 6,
      error: 'WEBHOOK_HTTP_503',
    });
  });

  it('does not retry what waiting cannot fix', async () => {
    await register('https://hooks.example.com/a');
    await raise(admin.organizationId, '2026-07');
    await raise(admin.organizationId, '2026-08');
    await raise(admin.organizationId, '2026-09');
    responses = [
      404,
      Object.assign(new Error('blocked'), { code: 'WEBHOOK_ADDRESS_BLOCKED' }),
      301,
    ];
    expect(await db.alertWebhooks.dispatchDue(now)).toBe(3);
    expect((await deliveries()).map((row) => [row['status'], row['last_error']])).toEqual([
      ['FAILED', 'WEBHOOK_HTTP_404'],
      ['FAILED', 'WEBHOOK_ADDRESS_BLOCKED'],
      ['FAILED', 'WEBHOOK_HTTP_301'],
    ]);
  });

  it('holds deliveries while an endpoint is disabled, and sends test deliveries on request', async () => {
    const webhook = await register('https://hooks.example.com/a');
    await raise();
    await call('put', `/${webhook.id}`, admin, { status: 'DISABLED', version: 1 }).expect(200);
    await call('put', `/${webhook.id}`, admin, { status: 'ACTIVE', version: 1 }).expect(409, {
      error: 'VERSION_CONFLICT',
    });
    await call('post', `/${webhook.id}/test`, admin).expect(409, {
      error: 'ALERT_WEBHOOK_DISABLED',
    });
    expect(await db.alertWebhooks.dispatchDue(now)).toBe(0);
    await call('put', `/${webhook.id}`, admin, { status: 'ACTIVE', version: 2 }).expect(200);
    const test = (await call('post', `/${webhook.id}/test`, admin).expect(202)).body;
    expect(test).toMatchObject({ eventType: 'webhook.test', status: 'PENDING', alertId: null });
    expect(await db.alertWebhooks.dispatchDue(now)).toBe(2);
    expect(sent.map((attempt) => (JSON.parse(attempt.body) as WebhookEvent).type).sort()).toEqual([
      'model.budget.alert',
      'webhook.test',
    ]);
  });

  it('is for admins of the organization only, and limits how many endpoints it has', async () => {
    const webhook = await register('https://hooks.example.com/a');
    await call('get', '', employee).expect(403);
    await call('post', '', employee, {
      url: 'https://hooks.example.com/b',
      description: '',
    }).expect(403);
    await call('put', `/${webhook.id}`, otherAdmin, { status: 'DISABLED', version: 1 }).expect(404);
    await call('post', `/${webhook.id}/test`, otherAdmin).expect(404);
    await call('put', '/not-a-uuid', admin, { status: 'DISABLED', version: 1 }).expect(400);
    await call('post', '', admin, {
      url: 'https://hooks.example.com/c',
      description: '',
      organizationId: otherAdmin.organizationId,
    }).expect(400);
    for (let n = 1; n < 10; n++) await register(`https://hooks.example.com/${n}`);
    await call('post', '', admin, { url: 'https://hooks.example.com/11', description: '' }).expect(
      409,
      { error: 'ALERT_WEBHOOK_LIMIT' },
    );
  });

  it('keeps endpoints and deliveries immutable except for their progress', async () => {
    const webhook = await register('https://hooks.example.com/a');
    await raise();
    await db.alertWebhooks.dispatchDue(now);
    const sql = rawSql(db);
    await expect(
      sql
        .prepare('UPDATE organization_alert_webhooks SET url=? WHERE id=?')
        .run('https://evil.example.com/', webhook.id),
    ).rejects.toThrow('ALERT_WEBHOOK_IMMUTABLE');
    await expect(sql.prepare('DELETE FROM organization_alert_webhooks').run()).rejects.toThrow(
      'ALERT_WEBHOOK_IMMUTABLE',
    );
    await expect(
      sql
        .prepare("UPDATE alert_webhook_deliveries SET status='PENDING', next_attempt_at='x'")
        .run(),
    ).rejects.toThrow('ALERT_WEBHOOK_DELIVERY_IMMUTABLE');
    await expect(sql.prepare('DELETE FROM alert_webhook_deliveries').run()).rejects.toThrow(
      'ALERT_WEBHOOK_DELIVERY_IMMUTABLE',
    );
  });

  it('does nothing unless the operator enables it', async () => {
    await db.close();
    await open(false);
    await call('get', '', admin).expect(404);
    await call('post', '', admin, { url: 'https://hooks.example.com/a', description: '' }).expect(
      404,
    );
    await raise();
    expect(await deliveries()).toEqual([]);
    expect(await db.alertWebhooks.dispatchDue(now)).toBe(0);
  });
});
