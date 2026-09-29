/**
 * Organization model spending limits (ADR 0021): the reserve/settle transport, limit
 * arithmetic, tenancy and lease checks, immutable usage and the admin API. The agent runtime
 * side is tested end to end in model-spending-runtime.spec.ts.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Actor,
  ModelBudgetAlert,
  ModelBudgetAlertList,
  ModelPrice,
  ModelPriceBook,
  ModelUsageReport,
  OrganizationModelBudget,
} from '@agents-foundry/contracts';
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
  const budget = (
    monthlyTokenLimit: number | null,
    runTokenLimit: number | null,
    cost: { monthly?: number; run?: number } = {},
  ) =>
    rawSql(db)
      .prepare(
        `INSERT INTO organization_model_budgets (organization_id,monthly_token_limit,run_token_limit,
         monthly_cost_limit_micros,run_cost_limit_micros,updated_by,updated_at) VALUES (?,?,?,?,?,'admin_demo',?)`,
      )
      .run(
        org,
        monthlyTokenLimit,
        runTokenLimit,
        cost.monthly ?? null,
        cost.run ?? null,
        new Date().toISOString(),
      );
  /** Sets test-model's price per million tokens in micros; null prices remove it. */
  const price = async (input: number | null, output: number | null) => {
    const sql = rawSql(db);
    const latest = await sql
      .prepare('SELECT id FROM model_prices WHERE organization_id=? ORDER BY seq DESC LIMIT 1')
      .get<{ id: string }>(org);
    await sql
      .prepare(
        `INSERT INTO model_prices (id,organization_id,provider,model,currency,input_micros_per_million,
         output_micros_per_million,supersedes,set_by,set_at) VALUES (?,?,'test-provider','test-model','USD',?,?,?,'admin_demo',?)`,
      )
      .run(randomUUID(), org, input, output, latest?.id ?? null, new Date().toISOString());
  };
  const costs = () =>
    rawSql(db)
      .prepare(
        'SELECT max_output_tokens, reserved_cost_micros, cost_micros FROM model_usage_reservations ORDER BY seq',
      )
      .all();
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

  it("limits cost at the model's price, charging each call the price it was reserved at", async () => {
    // $3 and $15 per million input and output tokens; $0.03 a month.
    await price(3_000_000, 15_000_000);
    await budget(null, null, { monthly: 30_000 });
    const correlation = await runningRun();
    // 1000 input tokens cost 3000 micros; the remaining 27000 buy 1800 output tokens.
    const first = await reserve(correlation, 1000, 4096);
    expect(first.maxOutputTokens).toBe(1800);
    expect(await reserve(correlation, 10, 4096)).toMatchObject({
      decision: 'DENIED',
      code: 'MODEL_BUDGET_EXCEEDED',
      reason: "The organization's monthly model cost limit is reached.",
    });
    // The price doubles while the call runs; it still settles at the price it was reserved at.
    await price(6_000_000, 30_000_000);
    await settle(correlation, first.reservationId, 1000, 200).expect(200);
    // 24000 left: 6000 for the input at the new price, 18000 for 600 output tokens.
    expect((await reserve(correlation, 1000, 4096)).maxOutputTokens).toBe(600);
    expect(await costs()).toEqual([
      { max_output_tokens: 1800, reserved_cost_micros: 30_000, cost_micros: 6000 },
      { max_output_tokens: 600, reserved_cost_micros: 24_000, cost_micros: null },
    ]);
    const audit = await rawSql(db)
      .prepare("SELECT metadata FROM audit_events WHERE event_type='model.budget.exceeded'")
      .all<{ metadata: string }>();
    expect(audit.map((row) => JSON.parse(row.metadata))).toEqual([
      expect.objectContaining({ scope: 'MONTHLY_COST', remainingCostMicros: 0 }),
    ]);
  });

  it('applies the per-run cost limit to each run separately', async () => {
    await price(1_000_000, 1_000_000);
    await budget(null, null, { run: 10_000 });
    const a = await runningRun();
    expect((await reserve(a, 1000, 4096)).maxOutputTokens).toBe(4096);
    expect((await reserve(a, 1000, 4096)).maxOutputTokens).toBe(3904);
    expect(await reserve(a, 10, 4096)).toMatchObject({
      decision: 'DENIED',
      reason: "This run's model cost limit is reached.",
    });
    const b = await runningRun();
    expect((await reserve(b, 1000, 4096)).maxOutputTokens).toBe(4096);
  });

  it('with a cost limit, refuses models without a price; without one, records them unpriced', async () => {
    const correlation = await runningRun();
    const unpriced = await reserve(correlation, 100, 1000);
    expect(unpriced.decision).toBe('ALLOWED');
    await settle(correlation, unpriced.reservationId, 100, 100).expect(200);
    expect(await costs()).toEqual([
      { max_output_tokens: 1000, reserved_cost_micros: null, cost_micros: null },
    ]);
    await budget(null, null, { monthly: 1_000_000 });
    const refusal = {
      decision: 'DENIED',
      code: 'MODEL_BUDGET_EXCEEDED',
      reason: 'The organization limits model cost, and this model has no price.',
    };
    expect(await reserve(correlation, 100, 1000)).toMatchObject(refusal);
    await price(1_000_000, 1_000_000);
    expect(await reserve(correlation, 100, 1000)).toMatchObject({ decision: 'ALLOWED' });
    // A removed price is no price.
    await price(null, null);
    expect(await reserve(correlation, 100, 1000)).toMatchObject(refusal);
    const audit = await rawSql(db)
      .prepare("SELECT metadata FROM audit_events WHERE event_type='model.price.unavailable'")
      .all<{ metadata: string }>();
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({ scope: 'PRICE', model: 'test-model' });
  });

  it('keeps prices and the cost of each call immutable', async () => {
    await price(1_000_000, 2_000_000);
    const correlation = await runningRun();
    const { reservationId } = await reserve(correlation, 10, 100);
    const sql = rawSql(db);
    await expect(
      sql.prepare('UPDATE model_usage_reservations SET reserved_cost_micros=0').run(),
    ).rejects.toThrow('MODEL_USAGE_IMMUTABLE');
    await settle(correlation, reservationId, 10, 10).expect(200);
    await expect(
      sql.prepare('UPDATE model_usage_reservations SET cost_micros=0').run(),
    ).rejects.toThrow('MODEL_USAGE_IMMUTABLE');
    await expect(
      sql.prepare('UPDATE model_prices SET input_micros_per_million=0').run(),
    ).rejects.toThrow('MODEL_PRICE_IMMUTABLE');
    await expect(sql.prepare('DELETE FROM model_prices').run()).rejects.toThrow(
      'MODEL_PRICE_IMMUTABLE',
    );
  });

  const alerts = () =>
    rawSql(db)
      .prepare(
        'SELECT scope, threshold_percent, limit_value, charged_value, currency FROM model_budget_alerts ORDER BY seq',
      )
      .all();
  const thresholds = (value: string) =>
    rawSql(db)
      .prepare('UPDATE organization_model_budgets SET alert_thresholds=?::smallint[]')
      .run(value);

  it('raises each monthly alert once, as charged usage reaches its threshold', async () => {
    await budget(10_000, null);
    await thresholds('{50,80}');
    const correlation = await runningRun();
    await reserve(correlation, 1000, 3000); // 40%
    expect(await alerts()).toEqual([]);
    const second = await reserve(correlation, 1000, 1000); // 60%
    await settle(correlation, second.reservationId, 1000, 1000).expect(200);
    await reserve(correlation, 1000, 1000); // 80%
    expect((await reserve(correlation, 10, 4096)).maxOutputTokens).toBe(1990); // 100%
    expect(await reserve(correlation, 10, 4096)).toMatchObject({ decision: 'DENIED' });
    expect(await alerts()).toEqual([
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 50,
        limit_value: 10_000,
        charged_value: 6000,
        currency: null,
      },
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 80,
        limit_value: 10_000,
        charged_value: 8000,
        currency: null,
      },
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 100,
        limit_value: 10_000,
        charged_value: 10_000,
        currency: null,
      },
    ]);
    const audit = await rawSql(db)
      .prepare("SELECT actor_id, metadata FROM audit_events WHERE event_type='model.budget.alert'")
      .all<{ actor_id: string; metadata: string }>();
    expect(audit.map((row) => [row.actor_id, JSON.parse(row.metadata).thresholdPercent])).toEqual([
      ['runtime-a', 50],
      ['runtime-a', 80],
      ['runtime-a', 100],
    ]);
  });

  it('alerts a monthly limit as reached when it refuses a call, and never for per-run limits', async () => {
    await budget(6000, 100_000);
    const correlation = await runningRun();
    await reserve(correlation, 1000, 4096); // 84.9%: the default 80% threshold
    expect(await reserve(correlation, 5000, 4096)).toMatchObject({ decision: 'DENIED' });
    expect(await alerts()).toEqual([
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 80,
        limit_value: 6000,
        charged_value: 5096,
        currency: null,
      },
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 100,
        limit_value: 6000,
        charged_value: 5096,
        currency: null,
      },
    ]);
    await rawSql(db)
      .prepare('UPDATE organization_model_budgets SET monthly_token_limit=NULL, run_token_limit=10')
      .run();
    expect(await reserve(correlation, 5000, 4096)).toMatchObject({ decision: 'DENIED' });
    expect(await alerts()).toHaveLength(2);
  });

  it('alerts on the monthly cost limit in its currency', async () => {
    await price(1_000_000, 1_000_000);
    await budget(null, null, { monthly: 10_000 });
    const correlation = await runningRun();
    await reserve(correlation, 1000, 7000);
    expect(await alerts()).toEqual([
      {
        scope: 'MONTHLY_COST',
        threshold_percent: 80,
        limit_value: 10_000,
        charged_value: 8000,
        currency: 'USD',
      },
    ]);
  });

  it('alerts when an admin lowers a limit below what the month has used', async () => {
    const correlation = await runningRun();
    await reserve(correlation, 1000, 4000);
    db.structure.authorize = async () => undefined;
    await db.modelSpending.setBudget(
      { id: 'admin_demo', organizationId: org, role: 'ADMIN' },
      { monthlyTokenLimit: 5000, runTokenLimit: null, alertThresholdsPercent: [90], version: 0 },
    );
    expect(await alerts()).toEqual([
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 90,
        limit_value: 5000,
        charged_value: 5000,
        currency: null,
      },
      {
        scope: 'MONTHLY_TOKENS',
        threshold_percent: 100,
        limit_value: 5000,
        charged_value: 5000,
        currency: null,
      },
    ]);
  });

  it('reports usage by agent and model for the month', async () => {
    await budget(100_000, null);
    const correlation = await runningRun();
    const unpriced = await reserve(correlation, 1, 1000);
    await settle(correlation, unpriced.reservationId, 0, 0).expect(200);
    await price(2_000_000, 10_000_000);
    await rawSql(db)
      .prepare('UPDATE organization_model_budgets SET monthly_cost_limit_micros=50000')
      .run();
    const settled = await reserve(correlation, 1000, 2000);
    await settle(correlation, settled.reservationId, 800, 200).expect(200);
    await reserve(correlation, 500, 1000);
    // The seeded demo admin has no membership; the report's admin check is covered below.
    db.structure.authorize = async () => undefined;
    const report = await db.modelSpending.usage(
      { id: 'admin_demo', organizationId: org, role: 'ADMIN' },
      {},
    );
    // Cost: 1600 + 2000 settled, 1000 + 10000 reserved; the unpriced call adds none.
    const totals = { chargedTokens: 2500, chargedCostMicros: 14_600, calls: 3, unpricedCalls: 1 };
    expect(report).toMatchObject({
      ...totals,
      inputTokens: 800,
      outputTokens: 200,
      unsettledReservedTokens: 1500,
      remainingTokens: 97_500,
      remainingCostMicros: 35_400,
      budget: { currency: 'USD', monthlyCostLimitMicros: 50_000 },
      byAgent: [{ agentId, ...totals }],
      byModel: [{ provider: 'test-provider', model: 'test-model', ...totals }],
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

  const call = (method: 'get' | 'put' | 'post', path: string, actor: Actor, body?: object) => {
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
      currency: 'USD',
      monthlyCostLimitMicros: null,
      runCostLimitMicros: null,
      alertThresholdsPercent: [80],
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

  const priceOf = (input: number, output: number, expectedPriceId: string | null) => ({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    expectedPriceId,
  });

  it('keeps an append-only price book with optimistic concurrency', async () => {
    expect((await call('get', '/api/organization/model-prices', admin).expect(200)).body).toEqual({
      currency: 'USD',
      prices: [],
    });
    const first = (
      await call('put', '/api/organization/model-prices', admin, priceOf(3e6, 15e6, null)).expect(
        200,
      )
    ).body as ModelPrice;
    expect(first).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      currency: 'USD',
      inputMicrosPerMillionTokens: 3_000_000,
      outputMicrosPerMillionTokens: 15_000_000,
      setBy: admin.id,
    });
    await call('put', '/api/organization/model-prices', admin, priceOf(1, 1, null)).expect(409, {
      error: 'VERSION_CONFLICT',
    });
    const second = (
      await call(
        'put',
        '/api/organization/model-prices',
        admin,
        priceOf(2e6, 10e6, first.priceId),
      ).expect(200)
    ).body as ModelPrice;
    expect(
      (
        (await call('get', '/api/organization/model-prices', admin).expect(200))
          .body as ModelPriceBook
      ).prices,
    ).toEqual([second]);
    const removal = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
    await call('post', '/api/organization/model-prices/remove', admin, {
      ...removal,
      expectedPriceId: first.priceId,
    }).expect(409);
    await call('post', '/api/organization/model-prices/remove', admin, {
      ...removal,
      expectedPriceId: second.priceId,
    }).expect(204);
    expect((await call('get', '/api/organization/model-prices', admin).expect(200)).body).toEqual({
      currency: 'USD',
      prices: [],
    });
    await call('put', '/api/organization/model-prices', admin, priceOf(1e6, 1e6, null)).expect(200);
    const events = await rawSql(db)
      .prepare(
        "SELECT action, before_json FROM organization_change_events WHERE resource_type='model_price' ORDER BY created_at",
      )
      .all<{ action: string; before_json: string | null }>();
    expect(events.map((event) => [event.action, event.before_json === null])).toEqual([
      ['model_price.updated', true],
      ['model_price.updated', false],
      ['model_price.removed', false],
      ['model_price.updated', true],
    ]);
    // Each organization has its own price book.
    expect(
      (
        (await call('get', '/api/organization/model-prices', otherAdmin).expect(200))
          .body as ModelPriceBook
      ).prices,
    ).toEqual([]);
  });

  it('rejects invalid prices and non-admins', async () => {
    for (const body of [
      priceOf(-1, 1, null),
      priceOf(1.5, 1, null),
      priceOf(1, 10_000_000_001, null),
      { ...priceOf(1, 1, null), model: 'bad model' },
      { ...priceOf(1, 1, null), expectedPriceId: undefined },
      { ...priceOf(1, 1, null), organizationId: otherAdmin.organizationId },
    ])
      await call('put', '/api/organization/model-prices', admin, body).expect(400);
    await call('get', '/api/organization/model-prices', employee).expect(403);
    await call('put', '/api/organization/model-prices', employee, priceOf(1, 1, null)).expect(403);
  });

  it('sets cost limits in a currency that is fixed once prices exist', async () => {
    const budget = (
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: null,
        runTokenLimit: null,
        currency: 'EUR',
        monthlyCostLimitMicros: 500_000_000,
        runCostLimitMicros: 5_000_000,
        version: 0,
      }).expect(200)
    ).body as OrganizationModelBudget;
    expect(budget).toMatchObject({
      currency: 'EUR',
      monthlyCostLimitMicros: 500_000_000,
      runCostLimitMicros: 5_000_000,
    });
    const set = (
      await call('put', '/api/organization/model-prices', admin, priceOf(1, 1, null)).expect(200)
    ).body as ModelPrice;
    expect(set.currency).toBe('EUR');
    await call('put', '/api/organization/model-budget', admin, {
      monthlyTokenLimit: null,
      runTokenLimit: null,
      currency: 'USD',
      version: 1,
    }).expect(409, { error: 'MODEL_CURRENCY_FIXED' });
    // A client that knows only token limits leaves the currency and cost limits unchanged.
    const tokensOnly = (
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: 1000,
        runTokenLimit: null,
        version: 1,
      }).expect(200)
    ).body as OrganizationModelBudget;
    expect(tokensOnly).toMatchObject({
      monthlyTokenLimit: 1000,
      currency: 'EUR',
      monthlyCostLimitMicros: 500_000_000,
      runCostLimitMicros: 5_000_000,
      version: 2,
    });
    for (const change of [
      { currency: 'eur' },
      { monthlyCostLimitMicros: 0 },
      { runCostLimitMicros: 1.5 },
    ])
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: null,
        runTokenLimit: null,
        version: 2,
        ...change,
      }).expect(400);
    const cleared = (
      await call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: null,
        runTokenLimit: null,
        monthlyCostLimitMicros: null,
        runCostLimitMicros: null,
        version: 2,
      }).expect(200)
    ).body as OrganizationModelBudget;
    expect(cleared).toMatchObject({ monthlyCostLimitMicros: null, runCostLimitMicros: null });
  });

  it('sets alert thresholds, keeping them when a client omits them', async () => {
    const put = (body: object, version: number) =>
      call('put', '/api/organization/model-budget', admin, {
        monthlyTokenLimit: 1000,
        runTokenLimit: null,
        version,
        ...body,
      });
    expect((await put({}, 0).expect(200)).body).toMatchObject({ alertThresholdsPercent: [80] });
    expect((await put({ alertThresholdsPercent: [50, 90] }, 1).expect(200)).body).toMatchObject({
      alertThresholdsPercent: [50, 90],
    });
    expect((await put({}, 2).expect(200)).body).toMatchObject({ alertThresholdsPercent: [50, 90] });
    expect((await put({ alertThresholdsPercent: [] }, 3).expect(200)).body).toMatchObject({
      alertThresholdsPercent: [],
    });
    for (const alertThresholdsPercent of [[0], [100], [50, 50], [10, 20, 30, 40, 50, 60], [5.5]])
      await put({ alertThresholdsPercent }, 4).expect(400);
  });

  it('lists and acknowledges alerts once, for admins of the organization only', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const alert = (organizationId: string) => {
      const id = randomUUID();
      return rawSql(db)
        .prepare(
          `INSERT INTO model_budget_alerts (id,organization_id,period,scope,threshold_percent,limit_value,charged_value,created_at)
           VALUES (?,?,?,'MONTHLY_TOKENS',80,1000,800,?)`,
        )
        .run(id, organizationId, period, new Date().toISOString())
        .then(() => id);
    };
    const id = await alert(admin.organizationId);
    const theirs = await alert(otherAdmin.organizationId);
    const list = (await call('get', '/api/organization/model-alerts', admin).expect(200))
      .body as ModelBudgetAlertList;
    expect(list).toEqual({
      period,
      alerts: [
        expect.objectContaining({
          id,
          scope: 'MONTHLY_TOKENS',
          thresholdPercent: 80,
          limit: 1000,
          charged: 800,
          currency: null,
          acknowledgedBy: null,
        }),
      ],
    });
    await call('get', '/api/organization/model-alerts?period=2001-01', admin).expect(200, {
      period: '2001-01',
      alerts: [],
    });
    await call('get', '/api/organization/model-alerts', employee).expect(403);
    await call('post', `/api/organization/model-alerts/${id}/acknowledge`, employee).expect(403);
    await call('post', `/api/organization/model-alerts/${theirs}/acknowledge`, admin).expect(404);
    await call('post', '/api/organization/model-alerts/not-a-uuid/acknowledge', admin).expect(400);
    const acknowledged = (
      await call('post', `/api/organization/model-alerts/${id}/acknowledge`, admin).expect(200)
    ).body as ModelBudgetAlert;
    expect(acknowledged).toMatchObject({ id, acknowledgedBy: admin.id });
    await call('post', `/api/organization/model-alerts/${id}/acknowledge`, admin).expect(409, {
      error: 'MODEL_BUDGET_ALERT_ACKNOWLEDGED',
    });
    const sql = rawSql(db);
    await expect(
      sql.prepare('UPDATE model_budget_alerts SET charged_value=0 WHERE id=?').run(theirs),
    ).rejects.toThrow('MODEL_BUDGET_ALERT_IMMUTABLE');
    await expect(
      sql
        .prepare(
          'UPDATE model_budget_alerts SET acknowledged_at=NULL, acknowledged_by=NULL WHERE id=?',
        )
        .run(id),
    ).rejects.toThrow('MODEL_BUDGET_ALERT_IMMUTABLE');
    await expect(sql.prepare('DELETE FROM model_budget_alerts').run()).rejects.toThrow(
      'MODEL_BUDGET_ALERT_IMMUTABLE',
    );
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
