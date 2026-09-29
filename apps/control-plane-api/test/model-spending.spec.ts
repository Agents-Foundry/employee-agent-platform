/**
 * Organization model spending limits (ADR 0021): the reserve/settle transport, limit
 * arithmetic, tenancy and lease checks, immutable usage and the admin API. The agent runtime
 * side is tested end to end in model-spending-runtime.spec.ts.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, ModelUsageReport, OrganizationModelBudget } from '@agents-foundry/contracts';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import type { ControlPlaneDatabase } from '../src/database.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { hashPassword } from '../src/passwords.js';
import { createDemoApp, demoRequest } from './helpers.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const primary = runtimeKeyPair();
const other = runtimeKeyPair();

describe('model spending at the runtime transport', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createDemoApp>;
  let agentId: string;

  beforeEach(async () => {
    db = await testDatabase({
      manifestV2Issuance: true,
      genericRuntime: true,
      runtimeIdentities: [
        {
          id: 'runtime-a',
          publicKeySpki: primary.spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
        {
          id: 'runtime-b',
          publicKeySpki: other.spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = await db.requestProvisioning(
      employeeId,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.1.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Checkout',
          repositoryUrl: 'https://example.com/repo',
          qaUrl: 'https://qa.example.com',
          issueTracker: ['Jira'],
          sourceControl: ['Bitbucket'],
          testingTechnologies: ['Playwright'],
        },
      },
      org,
    );
    agentId = manifestSubject(
      (await db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot')).manifest!
        .payload,
    ).agentId;
    app = createDemoApp(db);
  });
  afterEach(() => db.close());

  const post = (path: string, body: unknown, runtime: 'runtime-a' | 'runtime-b' = 'runtime-a') =>
    signedRuntimePost(
      app,
      runtime,
      runtime === 'runtime-a' ? primary.privateKey : other.privateKey,
      path,
      body,
    );

  /** Queues a run, claims it as runtime-a and reports it started; returns its correlation. */
  async function runningRun() {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({
          agentId,
          task: { objective: 'Validate STORY-1', workflow: 'validate-story', inputs: {} },
        })
        .expect(202)
    ).body as { id: string; threadId: string };
    const claim = (await post('/runtime/v1/commands/claim', undefined).expect(200)).body;
    expect(claim.command.run.runId).toBe(run.id);
    const correlation = {
      organizationId: org,
      employeeId,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    await post('/runtime/v1/events', {
      protocol: 'agents-foundry/runtime/v1',
      eventId: randomUUID(),
      runId: run.id,
      threadId: run.threadId,
      sequence: claim.lease.runtimeSequence + 1,
      type: 'run.started',
      occurredAt: new Date().toISOString(),
      correlation,
      payload: { runtimeSessionId: claim.lease.sessionId, kernel: 'test-kernel' },
    }).expect(201);
    return correlation;
  }

  const reservation = (
    correlation: object,
    estimatedInputTokens: number,
    maxOutputTokens: number,
    reservationId: string = randomUUID(),
  ) => ({
    protocol: 'agents-foundry/runtime/v1',
    reservationId,
    correlation,
    provider: 'test-provider',
    model: 'test-model',
    estimatedInputTokens,
    maxOutputTokens,
  });
  const reserve = async (correlation: object, input: number, output: number, id?: string) =>
    (
      await post('/runtime/v1/models/reserve', reservation(correlation, input, output, id)).expect(
        200,
      )
    ).body;
  const settle = (correlation: object, reservationId: string, input: number, output: number) =>
    post('/runtime/v1/models/settle', {
      protocol: 'agents-foundry/runtime/v1',
      reservationId,
      correlation,
      inputTokens: input,
      outputTokens: output,
    });
  const budget = (monthlyTokenLimit: number | null, runTokenLimit: number | null) =>
    rawSql(db)
      .prepare(
        `INSERT INTO organization_model_budgets (organization_id,monthly_token_limit,run_token_limit,updated_by,updated_at)
         VALUES (?,?,?,'admin_demo',?)`,
      )
      .run(org, monthlyTokenLimit, runTokenLimit, new Date().toISOString());
  const rows = () =>
    rawSql(db)
      .prepare(
        'SELECT id, status, reserved_tokens, max_output_tokens, input_tokens, output_tokens FROM model_usage_reservations ORDER BY seq',
      )
      .all();

  it('without a budget, reserves and settles every call, once, idempotently', async () => {
    const correlation = await runningRun();
    const id = randomUUID();
    expect(await reserve(correlation, 1200, 4096, id)).toEqual({
      reservationId: id,
      decision: 'ALLOWED',
      maxOutputTokens: 4096,
    });
    // A retried reservation returns the original decision; a different one under the same id is refused.
    expect(await reserve(correlation, 1200, 4096, id)).toMatchObject({ decision: 'ALLOWED' });
    await post('/runtime/v1/models/reserve', reservation(correlation, 1, 4096, id)).expect(409, {
      error: 'MODEL_RESERVATION_CONFLICT',
    });
    await settle(correlation, id, 900, 300).expect(200, { reservationId: id, status: 'SETTLED' });
    await settle(correlation, id, 900, 300).expect(200);
    await settle(correlation, id, 1, 1).expect(409, { error: 'MODEL_RESERVATION_SETTLED' });
    await settle(correlation, randomUUID(), 1, 1).expect(404, {
      error: 'MODEL_RESERVATION_NOT_FOUND',
    });
    expect(await rows()).toEqual([
      {
        id,
        status: 'SETTLED',
        reserved_tokens: 5296,
        max_output_tokens: 4096,
        input_tokens: 900,
        output_tokens: 300,
      },
    ]);
  });

  it('caps output at what the run may still use, then denies and audits', async () => {
    await budget(null, 5000);
    const correlation = await runningRun();
    const first = await reserve(correlation, 1000, 4096);
    expect(first.maxOutputTokens).toBe(4000);
    await settle(correlation, first.reservationId, 1000, 500).expect(200);
    // 3500 left; the second call is capped and stays unsettled, so it counts in full.
    expect((await reserve(correlation, 1000, 4096)).maxOutputTokens).toBe(2500);
    const denied = await reserve(correlation, 10, 4096);
    expect(denied).toMatchObject({
      decision: 'DENIED',
      code: 'MODEL_BUDGET_EXCEEDED',
      reason: "This run's model token limit is reached.",
    });
    expect(await rows()).toHaveLength(2);
    const audit = await rawSql(db)
      .prepare(
        "SELECT actor_id, metadata FROM audit_events WHERE event_type='model.budget.exceeded'",
      )
      .all<{ actor_id: string; metadata: string }>();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe('runtime-a');
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({ scope: 'RUN', remainingTokens: 0 });
  });

  it('applies the monthly limit across runs, counting unsettled reservations until they settle', async () => {
    await budget(6000, null);
    const a = await runningRun();
    const held = await reserve(a, 1000, 4096);
    expect(held.maxOutputTokens).toBe(4096);
    await settle(a, held.reservationId, 1000, 50).expect(200);
    // 6000 - 1050 = 4950 left: a call needing at least 1000 + 256 still fits, capped.
    const b = await runningRun();
    const second = await reserve(b, 1000, 4096);
    expect(second.maxOutputTokens).toBe(3950);
    expect(await reserve(b, 100, 4096)).toMatchObject({
      decision: 'DENIED',
      reason: "The organization's monthly model token limit is reached.",
    });
    await settle(b, second.reservationId, 200, 100).expect(200);
    expect((await reserve(b, 100, 4096)).maxOutputTokens).toBe(4096);
  });

  it('serializes concurrent reservations, so the last tokens are granted once', async () => {
    await budget(6000, null);
    const correlation = await runningRun();
    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => reserve(correlation, 1000, 4096)),
    );
    expect(decisions.map((d) => d.decision).sort()).toEqual([
      'ALLOWED',
      'DENIED',
      'DENIED',
      'DENIED',
      'DENIED',
    ]);
  });

  it('lets only the runtime holding a running run reserve, and settle only its own reservations', async () => {
    const correlation = await runningRun();
    await post('/runtime/v1/models/reserve', reservation(correlation, 10, 100), 'runtime-b').expect(
      403,
      { error: 'RUNTIME_LEASE_REQUIRED' },
    );
    await post(
      '/runtime/v1/models/reserve',
      reservation({ ...correlation, agentId: 'agent_other' }, 10, 100),
    ).expect(409, { error: 'RUNTIME_CORRELATION_MISMATCH' });
    await post('/runtime/v1/models/reserve', reservation(correlation, -1, 100)).expect(400);
    // Unknown fields, such as an organization, are rejected: tenancy comes from the lease.
    const smuggled = await post('/runtime/v1/models/reserve', {
      ...reservation(correlation, 10, 100),
      organizationId: 'org_someone_else',
    }).expect(400);
    expect(smuggled.body.error).toBe('RUNTIME_MODEL_USAGE_INVALID');
    const { reservationId } = await reserve(correlation, 10, 100);
    await post(
      '/runtime/v1/models/settle',
      {
        protocol: 'agents-foundry/runtime/v1',
        reservationId,
        correlation,
        inputTokens: 1,
        outputTokens: 1,
      },
      'runtime-b',
    ).expect(403);
    // After the run ends no call may be reserved, but a finished call is still settled.
    await demoRequest(app).post(`/api/execution/v1/runs/${correlation.runId}/cancel`).expect(200);
    await post('/runtime/v1/models/reserve', reservation(correlation, 10, 100)).expect(409);
    await settle(correlation, reservationId, 5, 5).expect(200);
  });

  it('keeps usage history immutable except for one settlement', async () => {
    const correlation = await runningRun();
    const { reservationId } = await reserve(correlation, 10, 100);
    const sql = rawSql(db);
    await expect(
      sql
        .prepare('UPDATE model_usage_reservations SET reserved_tokens=1 WHERE id=?')
        .run(reservationId),
    ).rejects.toThrow('MODEL_USAGE_IMMUTABLE');
    await settle(correlation, reservationId, 5, 5).expect(200);
    await expect(
      sql
        .prepare('UPDATE model_usage_reservations SET output_tokens=0 WHERE id=?')
        .run(reservationId),
    ).rejects.toThrow('MODEL_USAGE_IMMUTABLE');
    await expect(
      sql.prepare('DELETE FROM model_usage_reservations WHERE id=?').run(reservationId),
    ).rejects.toThrow('MODEL_USAGE_IMMUTABLE');
  });

  it('reports usage by agent and model for the month', async () => {
    await budget(100_000, null);
    const correlation = await runningRun();
    const settled = await reserve(correlation, 1000, 2000);
    await settle(correlation, settled.reservationId, 800, 200).expect(200);
    await reserve(correlation, 500, 1000);
    // The seeded demo admin has no membership; the report's admin check is covered below.
    db.structure.authorize = async () => undefined;
    const report = await db.modelSpending.usage(
      { id: 'admin_demo', organizationId: org, role: 'ADMIN' },
      {},
    );
    expect(report).toMatchObject({
      chargedTokens: 2500,
      calls: 2,
      inputTokens: 800,
      outputTokens: 200,
      unsettledReservedTokens: 1500,
      remainingTokens: 97_500,
      byAgent: [{ agentId, chargedTokens: 2500, calls: 2 }],
      byModel: [{ provider: 'test-provider', model: 'test-model', chargedTokens: 2500, calls: 2 }],
    });
    expect(report.period).toMatch(/^\d{4}-\d{2}$/);
    const empty = await db.modelSpending.usage(
      { id: 'admin_demo', organizationId: org, role: 'ADMIN' },
      { period: '2001-01' },
    );
    expect(empty).toMatchObject({ chargedTokens: 0, calls: 0, byAgent: [] });
  });
});

describe('model budget administration', () => {
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

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });
  beforeEach(async () => {
    db = await testDatabase({ seedDemo: false });
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
  });
  afterEach(() => db.close());

  const call = (method: 'get' | 'put', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', sessions.get(actor.id)!)
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };

  it('lets an organization admin set, change and clear limits with optimistic concurrency', async () => {
    expect((await call('get', '/api/organization/model-budget', admin).expect(200)).body).toEqual({
      monthlyTokenLimit: null,
      runTokenLimit: null,
      version: 0,
      updatedBy: null,
      updatedAt: null,
    });
    const set = (
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: 5_000_000,
        runTokenLimit: 200_000,
        version: 0,
      }).expect(200)
    ).body as OrganizationModelBudget;
    expect(set).toMatchObject({
      monthlyTokenLimit: 5_000_000,
      runTokenLimit: 200_000,
      version: 1,
      updatedBy: admin.id,
    });
    await call('put', '/api/organization/model-budget', admin, {
      monthlyTokenLimit: 1,
      runTokenLimit: null,
      version: 0,
    }).expect(409, { error: 'VERSION_CONFLICT' });
    const cleared = (
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: null,
        runTokenLimit: null,
        version: 1,
      }).expect(200)
    ).body as OrganizationModelBudget;
    expect(cleared).toMatchObject({ monthlyTokenLimit: null, runTokenLimit: null, version: 2 });
    const events = await rawSql(db)
      .prepare(
        "SELECT action, before_json FROM organization_change_events WHERE resource_type='model_budget' ORDER BY created_at",
      )
      .all<{ action: string; before_json: string | null }>();
    expect(events.map((event) => [event.action, event.before_json === null])).toEqual([
      ['model_budget.updated', true],
      ['model_budget.updated', false],
    ]);
  });

  it('rejects invalid limits, other roles and browser-supplied organizations', async () => {
    for (const body of [
      { monthlyTokenLimit: 0, runTokenLimit: null, version: 0 },
      { monthlyTokenLimit: 1.5, runTokenLimit: null, version: 0 },
      { monthlyTokenLimit: null, runTokenLimit: null },
      {
        monthlyTokenLimit: null,
        runTokenLimit: null,
        version: 0,
        organizationId: otherAdmin.organizationId,
      },
    ])
      await call('put', '/api/organization/model-budget', admin, body).expect(400);
    await call('get', '/api/organization/model-budget', employee).expect(403);
    await call('get', '/api/organization/model-usage', employee).expect(403);
    await call('get', '/api/organization/model-usage?period=2026-13', admin).expect(400);
    // Each organization sees and changes only its own budget.
    await call('put', '/api/organization/model-budget', admin, {
      monthlyTokenLimit: 10,
      runTokenLimit: null,
      version: 0,
    }).expect(200);
    expect(
      (await call('get', '/api/organization/model-budget', otherAdmin).expect(200)).body,
    ).toMatchObject({
      monthlyTokenLimit: null,
      version: 0,
    });
    const usage = (await call('get', '/api/organization/model-usage', admin).expect(200))
      .body as ModelUsageReport;
    expect(usage).toMatchObject({
      chargedTokens: 0,
      remainingTokens: 10,
      budget: { monthlyTokenLimit: 10 },
    });
  });

  it('is not served outside password mode', async () => {
    const demo = await testDatabase();
    try {
      await request(createDemoApp(demo))
        .get('/api/organization/model-budget')
        .set({ 'x-actor-id': 'admin_demo', 'x-actor-role': 'ADMIN', 'x-organization-id': org })
        .expect(404);
    } finally {
      await demo.close();
    }
  });
});
