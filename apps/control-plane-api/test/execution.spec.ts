import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, AgentEvent, AnySignedAgentManifest } from '@agents-foundry/contracts';
import { demoRequest as request, createDemoApp as createApp } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { migrateOrganization } from '../src/migrations/index.js';
import { verifyManifest } from '../../employee-desktop/src/app/verify-manifest.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { parseRuntimeCommand } from '../../../packages/contracts/src/runtime/v1/schemas.js';

const org = 'org_agents_foundry';
const employee: Actor = { id: 'employee_qa_demo', role: 'EMPLOYEE', organizationId: org };
const admin: Actor = { id: 'admin_demo', role: 'ADMIN', organizationId: org };
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

function raw(db: ControlPlaneDatabase): DatabaseSync {
  return (db as unknown as { db: DatabaseSync }).db;
}

function errorOf(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function startQaRun(
  app: ReturnType<typeof createApp>,
  agentId = 'agent_qa_engineer',
  conversationId?: string,
) {
  const conversation =
    conversationId ??
    (
      await request(app)
        .post('/api/conversations')
        .send({ employeeId: employee.id, agentId, title: 'STORY-7 QA validation' })
        .expect(201)
    ).body.id;
  const response = await request(app)
    .post('/api/qa/runs')
    .send({
      employeeId: employee.id,
      conversationId: conversation,
      storyKey: 'STORY-7',
      targetUrl: 'https://staging.example.com/cart',
    })
    .expect(202);
  return { conversationId: conversation as string, body: response.body };
}

describe('generic execution records for the legacy QA flow', () => {
  let db: ControlPlaneDatabase;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('dual-writes a paused generic run without changing the legacy response', async () => {
    const app = createApp(db);
    const { body } = await startQaRun(app);
    expect(body.run.status).toBe('AWAITING_APPROVAL');
    expect(body.run.plan).toHaveLength(6);
    expect(body.approval).toMatchObject({ status: 'PENDING', action: 'qa.execute_playwright' });
    expect(body.agentRun.status).toBe('WAITING_FOR_APPROVAL');
    expect(body.approval.runId).toBe(body.agentRun.id);

    const detail = (
      await request(app).get(`/api/execution/v1/runs/${body.agentRun.id}`).expect(200)
    ).body;
    expect(detail.run).toMatchObject({
      threadId: body.agentRun.threadId,
      legacyQaRunId: body.run.id,
      manifest: null,
      runtimeProfile: 'legacy-qa-static-plan',
      statusReason: 'APPROVAL_REQUIRED',
      task: { workflow: 'validate-story', workItem: { key: 'STORY-7' } },
    });
    expect(detail.run).not.toHaveProperty('runtimeSequence');
    expect(
      detail.steps.map((step: { kind: string; status: string }) => [step.kind, step.status]),
    ).toEqual([
      ['PLAN', 'COMPLETED'],
      ['ACTION', 'WAITING_FOR_APPROVAL'],
    ]);
    expect(detail.approvals).toEqual([
      expect.objectContaining({
        id: body.approval.id,
        stepId: detail.steps[1].id,
        status: 'PENDING',
      }),
    ]);
    const events = (
      await request(app).get(`/api/execution/v1/runs/${body.agentRun.id}/events`).expect(200)
    ).body;
    expect(events.items.map((event: AgentEvent) => event.type)).toEqual([
      'run.created',
      'run.started',
      'step.completed',
      'approval.requested',
      'run.paused',
    ]);
    expect(events.items.map((event: AgentEvent) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.nextAfterSequence).toBe(5);
    const page = (
      await request(app)
        .get(`/api/execution/v1/runs/${body.agentRun.id}/events?afterSequence=3&limit=1`)
        .expect(200)
    ).body;
    expect(page.items.map((event: AgentEvent) => event.type)).toEqual(['approval.requested']);
    const thread = (
      await request(app).get(`/api/execution/v1/threads/${body.agentRun.threadId}`).expect(200)
    ).body;
    expect(thread.thread.conversationId).toBeDefined();
    expect(thread.runs.map((run: { id: string }) => run.id)).toEqual([body.agentRun.id]);
  });

  it('resumes the paused run after approval, keeping legacy READY semantics', async () => {
    const app = createApp(db);
    const { body } = await startQaRun(app);
    await request(app)
      .post(`/api/approvals/${body.approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    const detail = db.execution.getRun(employee, body.agentRun.id);
    expect(detail.run).toMatchObject({ status: 'QUEUED', statusReason: 'APPROVAL_GRANTED' });
    expect(detail.steps[1]?.status).toBe('PENDING');
    expect(detail.approvals[0]?.status).toBe('APPROVED');
    const types = db.execution
      .listEvents(employee, body.agentRun.id, 0, 100)
      .items.map((e) => e.type);
    expect(types.at(-1)).toBe('approval.approved');
    const legacy = raw(db).prepare('SELECT status FROM qa_runs WHERE id=?').get(body.run.id);
    expect(legacy?.['status']).toBe('READY');
    // Repeated decisions stay rejected and do not append history.
    await request(app)
      .post(`/api/approvals/${body.approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'REJECTED' })
      .expect(409);
    expect(db.execution.listEvents(employee, body.agentRun.id, 0, 100).items).toHaveLength(6);
  });

  it('cancels the run on rejection and reuses the idle thread for the next request', async () => {
    const app = createApp(db);
    const first = await startQaRun(app);
    await request(app)
      .post(`/api/approvals/${first.body.approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'REJECTED' })
      .expect(200);
    const rejected = db.execution.getRun(employee, first.body.agentRun.id);
    expect(rejected.run).toMatchObject({ status: 'CANCELLED', statusReason: 'APPROVAL_REJECTED' });
    expect(rejected.run.completedAt).not.toBeNull();
    expect(rejected.steps[1]?.status).toBe('CANCELLED');
    expect(
      db.execution
        .listEvents(employee, first.body.agentRun.id, 0, 100)
        .items.slice(-2)
        .map((e) => e.type),
    ).toEqual(['approval.rejected', 'run.cancelled']);
    const second = await startQaRun(app, undefined, first.conversationId);
    expect(second.body.agentRun.threadId).toBe(first.body.agentRun.threadId);
  });

  it('keeps multiple pending legacy runs per conversation working via sibling threads', async () => {
    const app = createApp(db);
    const first = await startQaRun(app);
    const second = await startQaRun(app, undefined, first.conversationId);
    expect(second.body.run.status).toBe('AWAITING_APPROVAL');
    expect(second.body.agentRun.threadId).not.toBe(first.body.agentRun.threadId);
  });

  it('isolates runs, threads and events by tenant and owner', async () => {
    const app = createApp(db);
    const { body } = await startQaRun(app);
    const foreign: Actor = { id: employee.id, role: 'EMPLOYEE', organizationId: 'other-org' };
    const colleague: Actor = { id: 'someone-else', role: 'EMPLOYEE', organizationId: org };
    for (const actor of [foreign, colleague, { ...admin, organizationId: 'other-org' }]) {
      expect(errorOf(() => db.execution.getRun(actor, body.agentRun.id))).toBe('RUN_NOT_FOUND');
      expect(errorOf(() => db.execution.listEvents(actor, body.agentRun.id, 0, 10))).toBe(
        'RUN_NOT_FOUND',
      );
      expect(errorOf(() => db.execution.getThread(actor, body.agentRun.threadId))).toBe(
        'THREAD_NOT_FOUND',
      );
    }
    // Administrators can review the run for governance but not read its event history or thread.
    expect(db.execution.getRun(admin, body.agentRun.id).run.id).toBe(body.agentRun.id);
    await request(app)
      .get(`/api/execution/v1/runs/${body.agentRun.id}`)
      .set(adminHeaders)
      .expect(200);
    await request(app)
      .get(`/api/execution/v1/runs/${body.agentRun.id}/events`)
      .set(adminHeaders)
      .expect(404);
    await request(app)
      .get(`/api/execution/v1/threads/${body.agentRun.threadId}`)
      .set(adminHeaders)
      .expect(404);
    await request(app).get('/api/execution/v1/runs/not-a-uuid').expect(404);
    await request(app)
      .get(`/api/execution/v1/runs/${body.agentRun.id}/events?limit=1000`)
      .expect(400);
    await request(app)
      .get(`/api/execution/v1/runs/${body.agentRun.id}/events?organizationId=other-org`)
      .expect(400);
  });

  it('enforces tenant scope, append-only history and terminal immutability in the database', async () => {
    const app = createApp(db);
    const { body } = await startQaRun(app);
    const sql = raw(db);
    sql
      .prepare("INSERT INTO organizations (id, name, slug) VALUES ('other-org','Other','other')")
      .run();
    expect(
      errorOf(() =>
        sql
          .prepare(
            `INSERT INTO agent_events (id,organization_id,thread_id,run_id,sequence,event_type,source,payload,payload_hash,occurred_at,recorded_at)
             VALUES (?,?,?,?,99,'agent.message','CONTROL_PLANE','{}',?,?,?)`,
          )
          .run(
            randomUUID(),
            'other-org',
            body.agentRun.threadId,
            body.agentRun.id,
            'a'.repeat(64),
            'now',
            'now',
          ),
      ),
    ).toMatch(/FOREIGN KEY|EVENT_SCOPE_MISMATCH/);
    expect(errorOf(() => sql.prepare('UPDATE agent_events SET payload=?').run('{}'))).toMatch(
      'AGENT_EVENTS_APPEND_ONLY',
    );
    expect(errorOf(() => sql.prepare('DELETE FROM agent_events').run())).toMatch(
      'AGENT_EVENTS_APPEND_ONLY',
    );
    expect(errorOf(() => sql.prepare('DELETE FROM agent_runs').run())).toMatch(
      'RUN_HISTORY_RETAINED',
    );
    expect(
      errorOf(() => sql.prepare("UPDATE agent_runs SET employee_id='someone-else'").run()),
    ).toMatch('RUN_IDENTITY_IMMUTABLE');
    expect(
      errorOf(() =>
        sql.prepare('UPDATE approvals SET run_id=? WHERE id=?').run(randomUUID(), body.approval.id),
      ),
    ).toMatch('APPROVAL_RUN_LINK_IMMUTABLE');
    await request(app)
      .post(`/api/approvals/${body.approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'REJECTED' })
      .expect(200);
    expect(errorOf(() => sql.prepare("UPDATE agent_runs SET status='RUNNING'").run())).toMatch(
      'RUN_TERMINAL',
    );
  });
});

describe('Agent Manifest v2 and runtime ingestion', () => {
  let db: ControlPlaneDatabase;
  let manifest: AnySignedAgentManifest;
  let agentId: string;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', true, { manifestV2Issuance: true });
    const pending = db.requestProvisioning(employee.id, provisioning, org);
    manifest = db.decideProvisioning(pending.id, org, admin.id, 'APPROVED', 'Pilot').manifest!;
    agentId = manifestSubject(manifest.payload).agentId;
  });
  afterEach(() => db.close());

  it('issues, stores and verifies a resolved v2 manifest on server and desktop', async () => {
    expect(manifest.payload.apiVersion).toBe('agents-foundry/v2');
    if (manifest.payload.apiVersion !== 'agents-foundry/v2') return;
    expect(manifest.payload).toMatchObject({
      kind: 'AgentManifest',
      identity: { role: 'qa-engineer', department: 'Engineering' },
      runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
      connectors: [
        { id: 'jira', capabilities: ['issueTracker.read'] },
        { id: 'bitbucket', capabilities: ['sourceControl.read'] },
      ],
      mcp: ['playwright'],
      configuration: provisioning.answers,
    });
    expect(manifest.payload.policies.capabilities).toContainEqual({
      action: 'production.deploy',
      outcome: 'DENY',
    });
    expect(db.getManifest(agentId, org, employee.id)).toEqual(manifest);
    const expected = { agentId, employeeId: employee.id, organizationId: org };
    expect(await verifyManifest(manifest, db.signer.verificationKey, expected)).toBe(true);
    expect(
      await verifyManifest(manifest, db.signer.verificationKey, { ...expected, employeeId: 'x' }),
    ).toBe(false);
    const tampered = structuredClone(manifest);
    if (tampered.payload.apiVersion === 'agents-foundry/v2') tampered.payload.mcp.push('shell');
    expect(db.signer.verify(tampered)).toBe(false);
    expect(await verifyManifest(tampered, db.signer.verificationKey, expected)).toBe(false);
    const unknown = {
      ...manifest,
      payload: { ...manifest.payload, apiVersion: 'agents-foundry/v3' },
    };
    expect(db.signer.verify(unknown as AnySignedAgentManifest)).toBe(false);
    expect(
      await verifyManifest(unknown as AnySignedAgentManifest, db.signer.verificationKey, expected),
    ).toBe(false);
    raw(db)
      .prepare('UPDATE agent_manifests SET body=? WHERE agent_id=?')
      .run(JSON.stringify(unknown), agentId);
    expect(errorOf(() => db.getManifest(agentId, org))).toBe('MANIFEST_INVALID');
  });

  it('records the v2 manifest reference when the legacy QA flow uses a v2 agent', async () => {
    const { body } = await startQaRun(createApp(db), agentId);
    expect(db.execution.getRun(employee, body.agentRun.id).run.manifest).toEqual({
      manifestId: manifestSubject(manifest.payload).manifestId,
      apiVersion: 'agents-foundry/v2',
      keyId: db.signer.verificationKey.keyId,
    });
  });

  it('drives a generic run through submit, events, approval pause, resume and completion', () => {
    const run = db.execution.createRun({
      organizationId: org,
      employeeId: employee.id,
      agentId,
      title: 'Validate STORY-9',
      task: { objective: 'Validate STORY-9', workflow: 'validate-story', inputs: {} },
      manifest,
    });
    expect(run).toMatchObject({ status: 'QUEUED', runtimeProfile: 'standard-agent' });
    const command = db.execution.buildRunSubmitCommand(org, run.id);
    expect(parseRuntimeCommand(command)).toMatchObject({ type: 'run.submit' });
    expect(command.run.manifest).toEqual(manifest);

    const correlation = {
      organizationId: org,
      employeeId: employee.id,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    let sequence = 0;
    const send = (type: string, payload: object, extra: Record<string, unknown> = {}) => {
      const envelope = {
        protocol: 'agents-foundry/runtime/v1',
        eventId: randomUUID(),
        runId: run.id,
        threadId: run.threadId,
        sequence: ++sequence,
        type,
        occurredAt: new Date().toISOString(),
        correlation,
        payload,
        ...extra,
      };
      return { envelope, result: () => db.execution.ingestRuntimeEvent(org, envelope) };
    };

    const started = send('run.started', { runtimeSessionId: randomUUID(), kernel: 'test-kernel' });
    expect(started.result().duplicate).toBe(false);
    expect(db.execution.ingestRuntimeEvent(org, started.envelope).duplicate).toBe(true);
    expect(
      errorOf(() =>
        db.execution.ingestRuntimeEvent(org, {
          ...started.envelope,
          occurredAt: new Date(0).toISOString(),
        }),
      ),
    ).toBe('RUNTIME_EVENT_CONFLICT');
    expect(errorOf(() => db.execution.buildRunSubmitCommand(org, run.id))).toBe(
      'RUN_NOT_SUBMITTABLE',
    );

    const stepId = randomUUID();
    send('step.started', { kind: 'TOOL', title: 'Capture screenshot' }, { stepId }).result();
    const toolCallId = randomUUID();
    send(
      'tool.requested',
      { toolCallId, toolId: 'browser', toolVersion: '1.0.0', inputDigest: 'b'.repeat(64) },
      { stepId },
    ).result();
    const artifactId = randomUUID();
    send(
      'artifact.created',
      {
        artifact: {
          id: artifactId,
          type: 'screenshot',
          mediaType: 'image/png',
          name: 'cart.png',
          storageReference: `artifact://local-dev/${org}/${run.id}/cart.png`,
          checksum: { algorithm: 'sha256', value: 'c'.repeat(64) },
          sizeBytes: 2048,
          retentionPolicy: 'STANDARD_30D',
        },
      },
      { stepId },
    ).result();
    send('step.completed', { outputSummary: 'Captured' }, { stepId }).result();

    // Out-of-order, cross-tenant and mis-correlated events are rejected without side effects.
    const skipped = {
      ...send('agent.message', { content: 'skip' }).envelope,
      sequence: sequence + 5,
    };
    sequence--;
    expect(errorOf(() => db.execution.ingestRuntimeEvent(org, skipped))).toBe(
      'RUNTIME_EVENT_OUT_OF_ORDER',
    );
    const next = send('agent.message', { content: 'hello' }).envelope;
    sequence--;
    expect(errorOf(() => db.execution.ingestRuntimeEvent('other-org', next))).toBe(
      'RUNTIME_TENANT_FORBIDDEN',
    );
    expect(
      errorOf(() =>
        db.execution.ingestRuntimeEvent(org, {
          ...next,
          correlation: { ...correlation, employeeId: 'someone-else' },
        }),
      ),
    ).toBe('RUNTIME_CORRELATION_MISMATCH');

    send('run.paused', { reason: 'APPROVAL_REQUIRED', actionId: randomUUID() }).result();
    const resumeEarly = send('run.resumed', { approvalId: randomUUID() });
    expect(errorOf(resumeEarly.result)).toBe('ILLEGAL_RUN_TRANSITION');
    sequence--;

    // Stand-in for the Phase D Action Gateway: a governed approval linked to the paused run.
    const approvalId = randomUUID();
    raw(db)
      .prepare(
        `INSERT INTO approvals (id, organization_id, requested_by, action, resource_type, resource_id, risk, summary, status, created_at, run_id, step_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        approvalId,
        org,
        employee.id,
        'jira.issue.create',
        'agent_run',
        run.id,
        'MEDIUM',
        'Create defect',
        'PENDING',
        new Date().toISOString(),
        run.id,
        stepId,
      );
    expect(errorOf(() => db.decideApproval(approvalId, 'APPROVED', employee.id, org))).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    db.decideApproval(approvalId, 'APPROVED', admin.id, org);
    expect(db.execution.getRun(employee, run.id).run).toMatchObject({
      status: 'QUEUED',
      statusReason: 'APPROVAL_GRANTED',
    });

    send('run.resumed', { approvalId }).result();
    send('run.completed', { summary: 'Done', artifactIds: [artifactId] }).result();
    expect(errorOf(send('agent.message', { content: 'late' }).result)).toBe('RUN_TERMINAL');

    const detail = db.execution.getRun(employee, run.id);
    expect(detail.run).toMatchObject({ status: 'COMPLETED', statusReason: null });
    expect(detail.run.completedAt).not.toBeNull();
    expect(detail.steps).toEqual([
      expect.objectContaining({ id: stepId, kind: 'TOOL', status: 'COMPLETED' }),
    ]);
    expect(detail.artifacts).toEqual([
      expect.objectContaining({ id: artifactId, type: 'screenshot', sizeBytes: 2048 }),
    ]);
    expect(JSON.stringify(detail)).not.toContain('artifact://');
    const history = db.execution.listEvents(employee, run.id, 0, 100).items;
    expect(JSON.stringify(history)).not.toContain('artifact://');
    expect(history.map((event) => event.type)).toEqual([
      'run.created',
      'run.started',
      'step.started',
      'tool.requested',
      'artifact.created',
      'step.completed',
      'run.paused',
      'approval.approved',
      'run.resumed',
      'run.completed',
    ]);
    expect(history.filter((event) => event.source === 'RUNTIME')).toHaveLength(8);
  });

  it('refuses to submit runs whose agents only have a v1 manifest', () => {
    const v1 = new ControlPlaneDatabase(':memory:');
    try {
      const pending = v1.requestProvisioning(employee.id, provisioning, org);
      const legacyManifest = v1.decideProvisioning(
        pending.id,
        org,
        admin.id,
        'APPROVED',
        'Pilot',
      ).manifest!;
      const legacyAgent = manifestSubject(legacyManifest.payload).agentId;
      const run = v1.execution.createRun({
        organizationId: org,
        employeeId: employee.id,
        agentId: legacyAgent,
        title: 'Legacy',
        task: { objective: 'Legacy', inputs: {} },
        manifest: legacyManifest,
      });
      expect(errorOf(() => v1.execution.buildRunSubmitCommand(org, run.id))).toBe(
        'RUNTIME_MANIFEST_V2_REQUIRED',
      );
      expect(
        errorOf(() =>
          v1.execution.createRun({
            organizationId: org,
            employeeId: employee.id,
            agentId: legacyAgent,
            title: 'Busy',
            task: { objective: 'Busy', inputs: {} },
            manifest: legacyManifest,
            threadId: run.threadId,
          }),
        ),
      ).toBe('THREAD_HAS_ACTIVE_RUN');
      expect(
        errorOf(() =>
          v1.execution.createRun({
            organizationId: org,
            employeeId: 'someone-else',
            agentId: legacyAgent,
            title: 'Stolen',
            task: { objective: 'Stolen', inputs: {} },
            manifest: legacyManifest,
          }),
        ),
      ).toBe('MANIFEST_INVALID');
    } finally {
      v1.close();
    }
  });
});

describe('migration 006 upgrade', () => {
  it('upgrades a populated version-five database without touching existing rows', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      const legacy = Object.create(ControlPlaneDatabase.prototype) as {
        db: DatabaseSync;
        migrate(): void;
      };
      legacy.db = sql;
      legacy.migrate();
      migrateOrganization(sql, 5);
      sql.exec(`INSERT INTO organizations (id,name,slug) VALUES ('o','O','o');
        INSERT INTO employees (id,organization_id,display_name,email,role,team) VALUES ('e','o','E','e@example.com','EMPLOYEE','QA');
        INSERT INTO agents VALUES ('a','o','Agent','Engineering','QA','ACTIVE','[]');
        INSERT INTO conversations VALUES ('c','o','e','a','Title','2026-01-01','2026-01-01');
        INSERT INTO approvals (id,organization_id,requested_by,action,resource_type,resource_id,risk,summary,status,created_at)
          VALUES ('p','o','e','qa.execute_playwright','qa_run','q','MEDIUM','s','PENDING','2026-01-01');
        INSERT INTO qa_runs VALUES ('q','o','e','c','S-1','https://x.example','AWAITING_APPROVAL','[]','p','2026-01-01');`);
      migrateOrganization(sql, 6);
      expect(sql.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.['v']).toBe(6);
      expect(sql.prepare('SELECT status, run_id FROM approvals').get()).toEqual({
        status: 'PENDING',
        run_id: null,
      });
      expect(sql.prepare('SELECT count(*) AS n FROM qa_runs').get()?.['n']).toBe(1);
      expect(sql.prepare('SELECT count(*) AS n FROM agent_runs').get()?.['n']).toBe(0);
      migrateOrganization(sql, 6);
      expect(sql.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.['n']).toBe(6);
    } finally {
      sql.close();
    }
  });
});
