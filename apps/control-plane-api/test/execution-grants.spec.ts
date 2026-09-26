import { createHash, randomUUID, verify, createPublicKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { canonicalManifest, manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { executionGrantSigningInput } from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { parseSignedExecutionGrant } from '../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { sameRepository } from '../src/actions/execution-actions.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const adminHeaders = {
  'x-actor-id': 'admin_demo',
  'x-actor-role': 'ADMIN',
  'x-organization-id': org,
};
const runtime = runtimeKeyPair();
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalManifest(value)).digest('hex');

describe('execution grants', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let agentId: string;

  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', true, {
      manifestV2Issuance: true,
      genericRuntime: true,
      runtimeIdentities: [
        {
          id: 'runtime-g',
          publicKeySpki: runtime.spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = db.requestProvisioning(
      employeeId,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
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
      db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot').manifest!.payload,
    ).agentId;
    app = createApp(db);
  });
  afterEach(() => db.close());

  const post = (path: string, body?: unknown) =>
    signedRuntimePost(app, 'runtime-g', runtime.privateKey, path, body);

  const running = async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'x', inputs: {} } })
        .expect(202)
    ).body as { id: string; threadId: string };
    const claim = (await post('/runtime/v1/commands/claim').expect(200)).body;
    const correlation = {
      organizationId: org,
      employeeId,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    let sequence = 0;
    const emit = (type: string, payload: object, stepId?: string) =>
      post('/runtime/v1/events', {
        protocol: 'agents-foundry/runtime/v1',
        eventId: randomUUID(),
        runId: run.id,
        threadId: run.threadId,
        ...(stepId ? { stepId } : {}),
        sequence: ++sequence,
        type,
        occurredAt: new Date().toISOString(),
        correlation,
        payload,
      });
    await emit('run.started', { runtimeSessionId: claim.lease.sessionId, kernel: 'test' }).expect(
      201,
    );
    const stepId = randomUUID();
    await emit('step.started', { kind: 'TOOL', title: 'Tool' }, stepId).expect(201);
    const full = { ...correlation, stepId, toolCallId: randomUUID() };
    const ask = (action: string, toolId: string, parameters: object) =>
      post('/runtime/v1/actions', {
        protocol: 'agents-foundry/runtime/v1',
        requestId: randomUUID(),
        correlation: full,
        action,
        toolId,
        toolVersion: '1.0.0',
        inputDigest: digest(parameters),
        summary: 'x',
        parameters,
      });
    const grant = (requestId: string) =>
      post('/runtime/v1/actions/grant', {
        protocol: 'agents-foundry/runtime/v1',
        requestId,
        correlation: full,
      });
    return { run, emit, ask, grant };
  };

  it('issues one signed, operation-bound grant for an allowed in-scope operation', async () => {
    const { ask, grant } = await running();
    const operation = {
      kind: 'git.checkout',
      repositoryUrl: 'https://example.com/repo/',
      ref: 'main',
      path: 'repo',
    };
    const decision = (await ask('repository.read', 'repository', operation).expect(200)).body;
    expect(decision).toMatchObject({ decision: 'ALLOWED' });
    const signed = parseSignedExecutionGrant((await grant(decision.requestId).expect(200)).body);
    expect(signed.payload).toMatchObject({
      kind: 'agents-foundry/execution-grant/v1',
      requestId: decision.requestId,
      action: 'repository.read',
      operationKind: 'git.checkout',
      operationDigest: digest(operation),
      isolation: 'sandboxed',
      limits: {
        timeoutMs: 120_000,
        network: { mode: 'ALLOW_LIST', allowedHosts: ['example.com'] },
      },
    });
    expect(Date.parse(signed.payload.expiresAt) - Date.parse(signed.payload.issuedAt)).toBe(
      600_000,
    );
    const key = createPublicKey({
      key: Buffer.from(db.signer.verificationKey.publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(signed.signature, 'base64');
    expect(
      verify(null, Buffer.from(executionGrantSigningInput(signed.payload)), key, signature),
    ).toBe(true);
    // Domain separation: the same signature does not verify over the bare canonical payload.
    expect(verify(null, Buffer.from(canonicalManifest(signed.payload)), key, signature)).toBe(
      false,
    );
    // Redelivery returns the same grant; the execution runtime enforces single use.
    expect((await grant(decision.requestId).expect(200)).body).toEqual(signed);
    const sql = (db as unknown as { db: DatabaseSync }).db;
    expect(() => sql.prepare('DELETE FROM agent_execution_grants').run()).toThrow(
      'EXECUTION_GRANTS_IMMUTABLE',
    );
  });

  it('refuses grants for denied, unapproved, non-execution and tightened actions', async () => {
    const { ask, grant, emit } = await running();
    const foreign = await ask('repository.read', 'repository', {
      kind: 'git.checkout',
      repositoryUrl: 'https://evil.example.com/repo',
      ref: 'main',
      path: 'repo',
    }).expect(200);
    expect(foreign.body).toMatchObject({ decision: 'DENIED' });
    await grant(foreign.body.requestId).expect(403, { error: 'ACTION_DENIED' });
    expect(
      (
        await ask('repository.read', 'repository', {
          kind: 'playwright.run',
          project: 'x',
          baseUrl: 'https://qa.example.com',
        }).expect(200)
      ).body,
    ).toMatchObject({ decision: 'DENIED', reason: 'OPERATION_NOT_ALLOWED' });
    expect(
      (
        await ask('repository.read', 'repository', { kind: 'file.read', path: '../etc' }).expect(
          200,
        )
      ).body,
    ).toMatchObject({ decision: 'DENIED', reason: 'PARAMETERS_INVALID' });

    const status = await ask('repository.read', 'repository', {
      kind: 'git.status',
      path: 'repo',
    }).expect(200);
    (db as unknown as { db: DatabaseSync }).db
      .prepare(
        `INSERT INTO organization_action_policies (organization_id, action, outcome, reason, updated_by, updated_at)
         VALUES (?, 'repository.read', 'REQUIRE_APPROVAL', 'Tightened', 'admin_demo', ?)`,
      )
      .run(org, new Date().toISOString());
    await grant(status.body.requestId).expect(409, { error: 'APPROVAL_REQUIRED' });

    const pw = await ask('qa.execute_playwright', 'browser', {
      kind: 'playwright.run',
      project: 'smoke',
      baseUrl: 'https://qa.example.com/login',
    }).expect(200);
    expect(pw.body.decision).toBe('APPROVAL_REQUIRED');
    // The run is paused: no grant until a human approves and the run resumes.
    await grant(pw.body.requestId).expect(409, { error: 'RUN_NOT_RUNNING' });
    await request(app)
      .post(`/api/approvals/${pw.body.approvalId}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    await post('/runtime/v1/commands/claim').expect(200);
    await emit('run.resumed', { approvalId: pw.body.approvalId }).expect(201);
    const signed = (await grant(pw.body.requestId).expect(200)).body;
    const approval = (
      await request(app).get('/api/approvals').set(adminHeaders).expect(200)
    ).body.find((item: { id: string }) => item.id === pw.body.approvalId);
    expect(Date.parse(signed.payload.expiresAt)).toBeLessThanOrEqual(
      Date.parse(approval.expiresAt),
    );
    expect(signed.payload.limits.network.allowedHosts).toEqual(['qa.example.com']);
  });

  it('compares repositories by host, path and optional .git suffix only', () => {
    expect(sameRepository('https://Example.com/repo.git', 'https://example.com/repo/')).toBe(true);
    expect(sameRepository('https://example.com/repo', 'https://example.com/repo-other')).toBe(
      false,
    );
    expect(sameRepository('http://example.com/repo', 'https://example.com/repo')).toBe(false);
    expect(sameRepository('not a url', 'not a url')).toBe(false);
  });
});
