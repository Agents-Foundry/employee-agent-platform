import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnySignedAgentManifest } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { canonicalManifest, manifestSubject } from '../../../packages/contracts/src/manifest.js';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
} from '../../../packages/contracts/src/runtime/v1/transport.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const adminHeaders = {
  'x-actor-id': 'admin_demo',
  'x-actor-role': 'ADMIN',
  'x-organization-id': org,
};
const provisioning = {
  blueprintId: 'engineering.qa-engineer',
  blueprintVersion: '1.1.0',
  provider: 'test-provider',
  model: 'test-model',
  credentialMode: 'ORGANIZATION_MANAGED' as const,
  answers: {
    projectName: 'Checkout',
    repositoryUrl: 'https://example.com/repo',
    qaUrl: 'https://qa.example.com',
    issueTracker: ['Jira'],
    sourceControl: ['Bitbucket'],
    testingTechnologies: ['Playwright'],
  },
};

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

const primary = keyPair();
const other = keyPair();

function raw(db: ControlPlaneDatabase): DatabaseSync {
  return (db as unknown as { db: DatabaseSync }).db;
}

interface SignOptions {
  runtimeId?: string;
  key?: KeyObject;
  timestamp?: string;
  nonce?: string;
  signedPath?: string;
  signedBody?: string;
}

/** Sends one signed runtime request the way `ControlPlaneClient` does. */
function runtimePost(
  app: ReturnType<typeof createApp>,
  path: string,
  body?: unknown,
  options: SignOptions = {},
) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const nonce = options.nonce ?? randomUUID();
  const signature = sign(
    null,
    Buffer.from(
      runtimeSigningInput({
        method: 'POST',
        path: options.signedPath ?? path,
        timestamp,
        nonce,
        bodySha256: createHash('sha256')
          .update(options.signedBody ?? text)
          .digest('hex'),
      }),
    ),
    options.key ?? primary.privateKey,
  ).toString('base64');
  return request(app)
    .post(path)
    .set({
      'content-type': 'application/json',
      [runtimeAuthHeaders.runtimeId]: options.runtimeId ?? 'runtime-a',
      [runtimeAuthHeaders.timestamp]: timestamp,
      [runtimeAuthHeaders.nonce]: nonce,
      [runtimeAuthHeaders.signature]: signature,
    })
    .send(text);
}

describe('runtime transport', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let manifest: AnySignedAgentManifest;
  let agentId: string;

  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', true, {
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
        {
          id: 'runtime-elsewhere',
          publicKeySpki: other.spki,
          organizations: ['org_someone_else'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = db.requestProvisioning(employeeId, provisioning, org);
    manifest = db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot').manifest!;
    agentId = manifestSubject(manifest.payload).agentId;
    app = createApp(db);
  });
  afterEach(() => db.close());

  const startRun = async (workflow = 'validate-story') =>
    (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({
          agentId,
          task: { objective: 'Validate STORY-12', workflow, inputs: { story: 'STORY-12' } },
        })
        .expect(202)
    ).body as { id: string; threadId: string; status: string };

  /** Claims the run and emits run.started plus one TOOL step; returns an event sender. */
  async function started(runId: string, threadId: string) {
    const claim = (await runtimePost(app, '/runtime/v1/commands/claim').expect(200)).body;
    expect(claim.command).toMatchObject({ type: 'run.submit', run: { runId } });
    const correlation = { organizationId: org, employeeId, agentId, threadId, runId };
    let sequence = claim.lease.runtimeSequence;
    const event = (type: string, payload: object, stepId?: string) => ({
      protocol: 'agents-foundry/runtime/v1',
      eventId: randomUUID(),
      runId,
      threadId,
      ...(stepId ? { stepId } : {}),
      sequence: ++sequence,
      type,
      occurredAt: new Date().toISOString(),
      correlation,
      payload,
    });
    await runtimePost(
      app,
      '/runtime/v1/events',
      event('run.started', { runtimeSessionId: claim.lease.sessionId, kernel: 'test-kernel' }),
    ).expect(201);
    const stepId = randomUUID();
    await runtimePost(
      app,
      '/runtime/v1/events',
      event('step.started', { kind: 'TOOL', title: 'Tool call' }, stepId),
    ).expect(201);
    // Execution-runtime actions carry the exact operation they authorize (Phase E).
    const operations: Record<string, object> = {
      'repository.read': { kind: 'git.status', path: 'repo' },
      'qa.execute_playwright': {
        kind: 'playwright.run',
        project: 'smoke',
        baseUrl: 'https://qa.example.com/cart',
      },
    };
    const action = (actionName: string, toolId: string, extra: object = {}) => {
      const parameters = operations[actionName];
      return {
        protocol: 'agents-foundry/runtime/v1',
        requestId: randomUUID(),
        correlation: { ...correlation, stepId, toolCallId: randomUUID() },
        action: actionName,
        toolId,
        toolVersion: '1.0.0',
        inputDigest: parameters
          ? createHash('sha256').update(canonicalManifest(parameters)).digest('hex')
          : 'a'.repeat(64),
        summary: `Perform ${actionName}`,
        ...(parameters ? { parameters } : {}),
        ...extra,
      };
    };
    return {
      claim,
      stepId,
      correlation,
      event,
      action,
      back: () => sequence--,
    };
  }

  it('rejects unsigned, forged, replayed, stale and tampered requests identically', async () => {
    await request(app)
      .post('/runtime/v1/commands/claim')
      .expect(401, { error: 'RUNTIME_UNAUTHENTICATED' });
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      runtimeId: 'unknown',
    }).expect(401);
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      key: other.privateKey,
    }).expect(401);
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    }).expect(401);
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      signedPath: '/runtime/v1/events',
    }).expect(401);
    await runtimePost(app, '/runtime/v1/events', { a: 1 }, { signedBody: '{"a":2}' }).expect(401);
    const nonce = randomUUID();
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, { nonce }).expect(204);
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, { nonce }).expect(401);
    // Browser sessions never reach the runtime transport.
    await demoRequest(app).post('/runtime/v1/commands/claim').expect(401);
  });

  it('gates employee run creation behind the flag, ownership and the manifest', async () => {
    const disabled = new ControlPlaneDatabase(':memory:', true, { manifestV2Issuance: true });
    try {
      await demoRequest(createApp(disabled))
        .post('/api/execution/v1/runs')
        .send({ agentId: 'agent_qa_engineer', task: { objective: 'x', inputs: {} } })
        .expect(404, { error: 'GENERIC_RUNTIME_DISABLED' });
    } finally {
      disabled.close();
    }
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId, task: { objective: 'x', workflow: 'deploy-prod', inputs: {} } })
      .expect(400, { error: 'WORKFLOW_NOT_IN_MANIFEST' });
    await request(app)
      .post('/api/execution/v1/runs')
      .set(adminHeaders)
      .send({ agentId, task: { objective: 'x', inputs: {} } })
      .expect(404);
    // The unsigned demo agent has no manifest at all; a v1 agent cannot run on a runtime.
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId: 'agent_qa_engineer', task: { objective: 'x', inputs: {} } })
      .expect(404, { error: 'MANIFEST_NOT_FOUND' });
    const v1 = new ControlPlaneDatabase(':memory:', true, { genericRuntime: true });
    try {
      const pending = v1.requestProvisioning(employeeId, provisioning, org);
      const signed = v1.decideProvisioning(
        pending.id,
        org,
        'admin_demo',
        'APPROVED',
        'x',
      ).manifest!;
      await demoRequest(createApp(v1))
        .post('/api/execution/v1/runs')
        .send({
          agentId: manifestSubject(signed.payload).agentId,
          task: { objective: 'x', inputs: {} },
        })
        .expect(409, { error: 'RUNTIME_MANIFEST_V2_REQUIRED' });
    } finally {
      v1.close();
    }
    const run = await startRun();
    expect(run).toMatchObject({ status: 'QUEUED', runtimeProfile: 'standard-agent' });
    expect(run).not.toHaveProperty('runtimeSequence');
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId, threadId: run.threadId, task: { objective: 'again', inputs: {} } })
      .expect(409, { error: 'THREAD_HAS_ACTIVE_RUN' });
  });

  it('leases each queued run to one authorized runtime', async () => {
    await runtimePost(app, '/runtime/v1/commands/claim').expect(204);
    const run = await startRun();
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      runtimeId: 'runtime-elsewhere',
      key: other.privateKey,
    }).expect(204);
    const claim = (await runtimePost(app, '/runtime/v1/commands/claim').expect(200)).body;
    expect(claim.command.run.manifest).toEqual(manifest);
    expect(claim.lease).toMatchObject({ runtimeSequence: 0 });
    // Nobody else gets it, and the holder is not sent it twice while it is fresh.
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      runtimeId: 'runtime-b',
      key: other.privateKey,
    }).expect(204);
    await runtimePost(app, '/runtime/v1/commands/claim').expect(204);

    const correlation = {
      organizationId: org,
      employeeId,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    const envelope = (sessionId: string) => ({
      protocol: 'agents-foundry/runtime/v1',
      eventId: randomUUID(),
      runId: run.id,
      threadId: run.threadId,
      sequence: 1,
      type: 'run.started',
      occurredAt: new Date().toISOString(),
      correlation,
      payload: { runtimeSessionId: sessionId, kernel: 'test-kernel' },
    });
    await runtimePost(app, '/runtime/v1/events', envelope(claim.lease.sessionId), {
      runtimeId: 'runtime-b',
      key: other.privateKey,
    }).expect(403, { error: 'RUNTIME_LEASE_REQUIRED' });
    await runtimePost(app, '/runtime/v1/events', envelope(randomUUID())).expect(409, {
      error: 'RUNTIME_SESSION_MISMATCH',
    });
    const first = envelope(claim.lease.sessionId);
    await runtimePost(app, '/runtime/v1/events', first).expect(201);
    expect((await runtimePost(app, '/runtime/v1/events', first).expect(200)).body.duplicate).toBe(
      true,
    );
    expect(
      db.execution.getRun({ id: employeeId, role: 'EMPLOYEE', organizationId: org }, run.id).run
        .status,
    ).toBe('RUNNING');
  });

  it('allows, denies and pauses governed actions through policy and the manifest', async () => {
    const run = await startRun();
    const { action, stepId, event, back } = await started(run.id, run.threadId);

    const allowed = action('repository.read', 'repository');
    const allow = (await runtimePost(app, '/runtime/v1/actions', allowed).expect(200)).body;
    expect(allow).toMatchObject({ decision: 'ALLOWED', risk: 'LOW' });
    expect((await runtimePost(app, '/runtime/v1/actions', allowed).expect(200)).body).toEqual(
      allow,
    );
    await runtimePost(app, '/runtime/v1/actions', { ...allowed, summary: 'changed' }).expect(409, {
      error: 'RUNTIME_ACTION_CONFLICT',
    });

    const denials: [string, string, string][] = [
      ['production.deploy', 'repository', 'ACTION_NOT_GOVERNED_BY_TOOL'],
      ['repository.read', 'shell', 'TOOL_NOT_IN_MANIFEST'],
      ['jira.issue.create', 'repository', 'ACTION_NOT_GOVERNED_BY_TOOL'],
    ];
    for (const [name, tool, reason] of denials)
      expect(
        (await runtimePost(app, '/runtime/v1/actions', action(name, tool)).expect(200)).body,
      ).toMatchObject({
        decision: 'DENIED',
        reason,
      });
    expect(
      (
        await runtimePost(
          app,
          '/runtime/v1/actions',
          action('repository.read', 'repository', { toolVersion: '9.0.0' }),
        ).expect(200)
      ).body,
    ).toMatchObject({ decision: 'DENIED', reason: 'TOOL_VERSION_MISMATCH' });
    await runtimePost(app, '/runtime/v1/actions', {
      ...action('repository.read', 'repository'),
      extra: 1,
    }).expect(400);

    const governed = (
      await runtimePost(
        app,
        '/runtime/v1/actions',
        action('qa.execute_playwright', 'browser'),
      ).expect(200)
    ).body;
    expect(governed).toMatchObject({ decision: 'APPROVAL_REQUIRED', risk: 'MEDIUM' });
    const employee = { id: employeeId, role: 'EMPLOYEE' as const, organizationId: org };
    const paused = db.execution.getRun(employee, run.id);
    expect(paused.run).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      statusReason: 'APPROVAL_REQUIRED',
    });
    expect(paused.steps.find((step) => step.id === stepId)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(paused.approvals).toEqual([
      expect.objectContaining({
        id: governed.approvalId,
        action: 'qa.execute_playwright',
        stepId,
        status: 'PENDING',
      }),
    ]);
    // Paused runs accept no further actions or activity from the runtime.
    await runtimePost(app, '/runtime/v1/actions', action('repository.read', 'repository')).expect(
      409,
      {
        error: 'RUN_NOT_RUNNING',
      },
    );
    await runtimePost(app, '/runtime/v1/events', event('agent.message', { content: 'x' })).expect(
      409,
    );
    back();
    await runtimePost(app, '/runtime/v1/commands/claim').expect(204);

    // The requesting employee cannot approve; an administrator can.
    const approvals = (await demoRequest(app).get('/api/approvals').expect(200)).body;
    expect(approvals.some((item: { id: string }) => item.id === governed.approvalId)).toBe(true);
    await request(app)
      .post(`/api/approvals/${governed.approvalId}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    const resume = (await runtimePost(app, '/runtime/v1/commands/claim').expect(200)).body;
    expect(resume.command).toMatchObject({
      type: 'run.resume',
      runId: run.id,
      approval: { approvalId: governed.approvalId, decision: 'APPROVED' },
    });
    await runtimePost(app, '/runtime/v1/commands/claim', undefined, {
      runtimeId: 'runtime-b',
      key: other.privateKey,
    }).expect(204);
    await runtimePost(
      app,
      '/runtime/v1/events',
      event('run.resumed', { approvalId: randomUUID() }),
    ).expect(409, {
      error: 'RUNTIME_APPROVAL_MISMATCH',
    });
    back();
    await runtimePost(
      app,
      '/runtime/v1/events',
      event('run.resumed', { approvalId: governed.approvalId }),
    ).expect(201);
    const resumed = db.execution.getRun(employee, run.id);
    expect(resumed.run.status).toBe('RUNNING');
    expect(resumed.steps.find((step) => step.id === stepId)?.status).toBe('RUNNING');
    await runtimePost(app, '/runtime/v1/events', event('step.completed', {}, stepId)).expect(201);
    await runtimePost(
      app,
      '/runtime/v1/events',
      event('run.completed', { summary: 'Done', artifactIds: [] }),
    ).expect(201);
    const lease = raw(db).prepare('SELECT state FROM agent_run_leases WHERE run_id=?').get(run.id);
    expect(lease).toEqual({ state: 'CLOSED' });
    const audit = raw(db)
      .prepare(
        "SELECT event_type FROM audit_events WHERE resource_id=? AND event_type LIKE 'runtime.%' ORDER BY rowid",
      )
      .all(run.id)
      .map((row) => row['event_type']);
    expect(audit).toEqual([
      'runtime.run.claimed',
      'runtime.action.allowed',
      'runtime.action.denied',
      'runtime.action.denied',
      'runtime.action.denied',
      'runtime.action.denied',
      'runtime.action.approval_required',
    ]);
  });

  it('delivers run.cancel after a rejection or an employee cancellation', async () => {
    const run = await startRun();
    const { action } = await started(run.id, run.threadId);
    const governed = (
      await runtimePost(
        app,
        '/runtime/v1/actions',
        action('qa.execute_playwright', 'browser'),
      ).expect(200)
    ).body;
    await request(app)
      .post(`/api/approvals/${governed.approvalId}/decision`)
      .set(adminHeaders)
      .send({ decision: 'REJECTED' })
      .expect(200);
    const cancel = (await runtimePost(app, '/runtime/v1/commands/claim').expect(200)).body;
    expect(cancel.command).toMatchObject({
      type: 'run.cancel',
      runId: run.id,
      reason: 'APPROVAL_REJECTED',
    });
    await runtimePost(app, '/runtime/v1/commands/claim').expect(204);

    const second = await startRun();
    await runtimePost(app, '/runtime/v1/commands/claim').expect(200);
    const cancelled = (
      await demoRequest(app).post(`/api/execution/v1/runs/${second.id}/cancel`).expect(200)
    ).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', statusReason: 'CANCELLED_BY_EMPLOYEE' });
    await demoRequest(app).post(`/api/execution/v1/runs/${second.id}/cancel`).expect(409);
    expect(
      (await runtimePost(app, '/runtime/v1/commands/claim').expect(200)).body.command,
    ).toMatchObject({
      type: 'run.cancel',
      runId: second.id,
    });
  });

  it('cancels a queued run whose manifest no longer verifies instead of submitting it', async () => {
    const run = await startRun();
    const body = raw(db).prepare('SELECT body FROM agent_manifests WHERE agent_id=?').get(agentId)![
      'body'
    ];
    const tampered = JSON.parse(String(body));
    tampered.payload.tools.push('shell');
    raw(db)
      .prepare('UPDATE agent_manifests SET body=? WHERE agent_id=?')
      .run(JSON.stringify(tampered), agentId);
    await runtimePost(app, '/runtime/v1/commands/claim').expect(204);
    const detail = db.execution.getRun(
      { id: employeeId, role: 'EMPLOYEE', organizationId: org },
      run.id,
    );
    expect(detail.run).toMatchObject({ status: 'CANCELLED', statusReason: 'MANIFEST_INVALID' });
  });

  it('rejects runtime identity configuration that is not an Ed25519 public key', () => {
    expect(
      () =>
        new ControlPlaneDatabase(':memory:', true, {
          runtimeIdentities: [
            { id: 'bad', publicKeySpki: 'AAAA', organizations: [org], runtimeProfiles: ['x'] },
          ],
        }),
    ).toThrow('RUNTIME_IDENTITY_CONFIG_INVALID');
    expect(
      () =>
        new ControlPlaneDatabase(':memory:', true, {
          runtimeIdentities: [
            {
              id: 'bad',
              publicKeySpki: primary.spki,
              organizations: ['*', org],
              runtimeProfiles: ['x'],
            },
          ],
        }),
    ).toThrow('RUNTIME_IDENTITY_CONFIG_INVALID');
  });
});
