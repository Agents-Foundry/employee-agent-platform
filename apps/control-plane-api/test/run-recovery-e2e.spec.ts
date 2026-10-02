import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, RuntimeCheckpointRecord } from '@agents-foundry/contracts';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway, type ModelResponse } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import type { ToolExecutionContext } from '../../agent-runtime/src/tools/runtime-tool.js';
import { ArtifactTool } from '../../agent-runtime/src/tools/artifact-tool.js';
import { IssueTrackerTool } from '../../agent-runtime/src/tools/issue-tracker-tool.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { ControlPlaneCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const answers = {
  projectName: 'Checkout',
  repositoryUrl: 'https://example.com/repo',
  qaUrl: 'https://qa.example.com',
  issueTracker: ['Jira'],
  sourceControl: ['Bitbucket'],
  testingTechnologies: ['Playwright'],
};
const draft = {
  projectKey: 'QA',
  summary: 'Cart total ignores the discount',
  description: 'Steps: add a discounted item.\n\nExpected: discounted total.',
  issueType: 'Bug',
};
const TOKEN = 'jira-api-token-value';
const MODEL_KEY = 'sk-test-model-key-value-000111222';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const keys = { a: runtimeKeyPair(), b: runtimeKeyPair(), foreign: runtimeKeyPair() };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Stores a report, files a defect, then answers. Stateless, so either runtime can play it. */
const script = (input: { messages: { content: { type: string }[] }[] }): ModelResponse => {
  const results = input.messages.flatMap((message) =>
    message.content.filter((block) => block.type === 'tool_result'),
  ).length;
  const usage = { inputTokens: 1, outputTokens: 1 };
  if (results === 0)
    return {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'artifact',
          input: { name: 'plan.md', type: 'report', mediaType: 'text/markdown', content: '# Plan' },
        },
      ],
      stopReason: 'tool_use',
      usage,
    };
  if (results === 1)
    return {
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'issue-tracker', input: draft }],
      stopReason: 'tool_use',
      usage,
    };
  return { content: [{ type: 'text', text: 'Filed the defect.' }], stopReason: 'end_turn', usage };
};

/** The real tool, in a runtime that dies right after the control plane performed the action. */
class DyingIssueTool extends IssueTrackerTool {
  hang: Promise<void> | null = null;
  override async execute(
    input: Parameters<IssueTrackerTool['execute']>[0],
    context: ToolExecutionContext,
  ) {
    const output = await super.execute(input, context);
    if (this.hang) await this.hang;
    return output;
  }
}

const settle = async (done: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The condition was never met.');
};

describe('durable run recovery end to end (ADR 0032)', () => {
  let hash: string;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let admin: Actor;
  let employee: Actor;
  let otherAdmin: Actor;
  let jira: unknown[];
  let agentId: string;
  const sessions = new Map<string, string>();
  const hosts: RuntimeHost[] = [];

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });

  beforeEach(async () => {
    const secrets = new MemorySecretStore();
    jira = [];
    db = await testDatabase({
      seedDemo: false,
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      connectorFetch: async (_url, init) => {
        jira.push(JSON.parse(String(init!.body)));
        return Response.json({ id: '10001', key: 'QA-42' }, { status: 201 });
      },
      runtimeIdentities: [
        ...(['a', 'b'] as const).map((name) => ({
          id: `runtime-${name}`,
          publicKeySpki: keys[name].spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        })),
        {
          id: 'runtime-foreign',
          publicKeySpki: keys.foreign.spki,
          organizations: ['org_somebody_else'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    app = createApp(db, config);
    const tenant = async (name: string) => {
      const org = await db.createCustomer(
        { name, slug: name.toLowerCase() },
        { displayName: 'Admin', email: `admin@${name}.example`, team: 'Admin' },
      );
      await db.acceptInvitation(hashToken(org.token), hash);
      return { id: org.employeeId, organizationId: org.organizationId, role: 'ADMIN' as const };
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
    secrets.set(admin.organizationId, 'jira-token', TOKEN);
    sessions.clear();
    for (const actor of [admin, employee, otherAdmin]) {
      const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
      await db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
      sessions.set(actor.id, `af_session=${token}`);
    }
    await call('post', '/api/organization/connector-connections', admin, {
      provider: 'jira',
      name: 'Alpha Jira',
      baseUrl: 'https://alpha.atlassian.net',
      secretRef: 'secret://jira-token',
      settings: { authEmail: 'bot@alpha.example', allowedProjects: ['QA'] },
    }).expect(201);
    const [assignment] = (
      await call('post', '/api/organization/agents', admin, {
        requestId: randomUUID(),
        name: 'Checkout QA agent',
        employeeIds: [employee.id],
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers,
      }).expect(201)
    ).body;
    agentId = assignment.agentId;
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    hosts.length = 0;
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.drain()));
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  const raw = () => rawSql(db);
  const call = (method: 'get' | 'post', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', sessions.get(actor.id)!)
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };
  const post = (name: keyof typeof keys, path: string, body?: unknown) =>
    signedRuntimePost(app, `runtime-${name}`, keys[name].privateKey, path, body);

  /** An agent runtime process with durable checkpoints and nothing else of its own. */
  const runtime = (name: 'a' | 'b', issues: IssueTrackerTool = new IssueTrackerTool()) => {
    const controlPlane = new ControlPlaneClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      runtimeId: `runtime-${name}`,
      privateKey: keys[name].privateKey,
    });
    const host = new RuntimeHost({
      controlPlane,
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway([new ScriptedProvider('test-provider', script)], {
        resolve: async () => ({ apiKey: MODEL_KEY }),
      }),
      modelCredentials: () => ({ resolve: async () => ({ apiKey: MODEL_KEY }) }),
      tools: new ToolRegistry([new ArtifactTool(), issues]),
      artifacts: new MemoryArtifactStore(),
      checkpoints: new ControlPlaneCheckpointStore(controlPlane),
      logger: silent,
    });
    hosts.push(host);
    return host;
  };

  const startRun = async () =>
    (
      await call('post', '/api/execution/v1/runs', employee, {
        agentId,
        task: { objective: 'File the checkout defect', inputs: {} },
      }).expect(202)
    ).body as { id: string; threadId: string };
  const approve = async (runId: string) => {
    const approval = (await db.execution.getRun(employee, runId)).approvals[0]!;
    await call('post', `/api/approvals/${approval.id}/decision`, admin, {
      decision: 'APPROVED',
    }).expect(200);
    return approval.id;
  };
  /** The runtime holding the run stopped signalling it longer ago than a lease lasts. */
  const expireLease = (runId: string, ago = 60_000) =>
    raw()
      .prepare('UPDATE agent_run_leases SET lease_expires_at=?, heartbeat_at=? WHERE run_id=?')
      .run(
        new Date(Date.now() - ago).toISOString(),
        new Date(Date.now() - ago).toISOString(),
        runId,
      );
  const lease = (runId: string) =>
    raw().prepare('SELECT * FROM agent_run_leases WHERE run_id=?').get(runId);
  const checkpoints = (runId: string) =>
    raw().prepare('SELECT * FROM agent_run_checkpoints WHERE run_id=? ORDER BY version').all(runId);
  const correlationOf = (run: { id: string; threadId: string }) => ({
    organizationId: admin.organizationId,
    employeeId: employee.id,
    agentId,
    threadId: run.threadId,
    runId: run.id,
  });

  /** Runtime A works the run up to the approved defect, performs it, and dies holding the result. */
  const abandonAfterTheDefect = async () => {
    const run = await startRun();
    const tool = new DyingIssueTool();
    const runtimeA = runtime('a', tool);
    expect(await runtimeA.pollOnce()).toBe(true);
    await runtimeA.drain();
    expect((await db.execution.getRun(employee, run.id)).run.status).toBe('WAITING_FOR_APPROVAL');
    await approve(run.id);
    let release!: () => void;
    tool.hang = new Promise<void>((resolve) => (release = resolve));
    const filed = jira.length;
    expect(await runtimeA.pollOnce()).toBe(true);
    await settle(() => jira.length === filed + 1);
    return { run, runtimeA, release };
  };

  it('lets runtime B finish the run runtime A abandoned, without repeating the external action', async () => {
    const { run, runtimeA, release } = await abandonAfterTheDefect();
    // Runtime A completed the report step and the approval pause before it stopped.
    let detail = await db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('RUNNING');
    expect(detail.steps.map((step) => [step.kind, step.status])).toEqual([
      ['MODEL', 'COMPLETED'],
      ['TOOL', 'COMPLETED'],
      ['MODEL', 'COMPLETED'],
      ['TOOL', 'RUNNING'],
    ]);
    expect((await lease(run.id))!['runtime_id']).toBe('runtime-a');
    expect((await checkpoints(run.id)).length).toBeGreaterThan(0);

    // While runtime A's lease is live nobody else is given the run.
    const runtimeB = runtime('b');
    expect(await runtimeB.pollOnce()).toBe(false);

    await expireLease(run.id);
    expect(await runtimeB.pollOnce()).toBe(true);
    await runtimeB.drain();

    detail = await db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('COMPLETED');
    // The defect was filed exactly once: runtime B was answered from the recorded execution.
    expect(jira).toHaveLength(1);
    expect(
      await raw().prepare('SELECT status FROM agent_action_executions WHERE run_id=?').all(run.id),
    ).toEqual([{ status: 'SUCCEEDED' }]);
    expect(
      await raw().prepare('SELECT decision FROM agent_action_requests WHERE run_id=?').all(run.id),
    ).toHaveLength(1);
    expect(detail.steps.map((step) => [step.kind, step.status])).toEqual([
      ['MODEL', 'COMPLETED'],
      ['TOOL', 'COMPLETED'],
      ['MODEL', 'COMPLETED'],
      ['TOOL', 'COMPLETED'],
      ['MODEL', 'COMPLETED'],
    ]);
    expect(detail.artifacts).toHaveLength(1);
    const events = (await db.execution.listEvents(employee, run.id, 0, 200)).items;
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'run.started')).toHaveLength(1);
    expect(types.filter((type) => type === 'model.requested')).toHaveLength(3);
    expect(types.at(-1)).toBe('run.completed');
    expect(events.at(-1)!.payload).toMatchObject({ summary: 'Filed the defect.' });

    expect(await lease(run.id)).toMatchObject({
      runtime_id: 'runtime-b',
      state: 'CLOSED',
      recoveries: 1,
    });
    const audit = await raw()
      .prepare("SELECT metadata FROM audit_events WHERE event_type='runtime.run.recovered'")
      .all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).toContain('runtime-a');
    // Checkpoints hold conversation content, so they go when the run ends.
    expect(await checkpoints(run.id)).toEqual([]);

    // Runtime A comes back to life: nothing it does reaches the run any more.
    release();
    await runtimeA.drain();
    expect((await db.execution.getRun(employee, run.id)).run.status).toBe('COMPLETED');
    expect((await db.execution.listEvents(employee, run.id, 0, 200)).items).toHaveLength(
      events.length,
    );
    expect(jira).toHaveLength(1);
  }, 60_000);

  it('resumes an approved run in runtime B when the runtime that paused it is gone', async () => {
    const run = await startRun();
    const runtimeA = runtime('a');
    await runtimeA.pollOnce();
    await runtimeA.drain();
    const runtimeB = runtime('b');
    // Paused and unanswered: there is nothing for anyone to do, however old the lease.
    await expireLease(run.id);
    expect(await runtimeB.pollOnce()).toBe(false);
    await approve(run.id);
    await expireLease(run.id);
    expect(await runtimeB.pollOnce()).toBe(true);
    await runtimeB.drain();
    const detail = await db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    expect(detail.steps.every((step) => step.status === 'COMPLETED')).toBe(true);
    // Handing over a paused run is not a crash recovery.
    expect(await lease(run.id)).toMatchObject({ runtime_id: 'runtime-b', recoveries: 0 });
  }, 60_000);

  it('keeps checkpoints inside their tenant, their lease and their version order', async () => {
    const run = await startRun();
    const runtimeA = runtime('a');
    await runtimeA.pollOnce();
    await runtimeA.drain();
    const correlation = correlationOf(run);
    const load = { protocol: 'agents-foundry/runtime/v1', correlation };

    // Only the runtime holding the run's lease can read or write its checkpoints.
    await post('b', '/runtime/v1/checkpoints/load', load).expect(403, {
      error: 'RUNTIME_LEASE_REQUIRED',
    });
    await post('foreign', '/runtime/v1/checkpoints/load', load).expect(403, {
      error: 'RUNTIME_LEASE_REQUIRED',
    });
    const record = (await post('a', '/runtime/v1/checkpoints/load', load).expect(200))
      .body as RuntimeCheckpointRecord;
    expect(record.sha256).toBe(sha256(record.body));
    const sessionId = String((await lease(run.id))!['session_id']);
    // The same state again, as the next version.
    const body = JSON.stringify({ ...JSON.parse(record.body), version: record.version + 1 });
    const next = {
      protocol: 'agents-foundry/runtime/v1',
      correlation,
      sessionId,
      version: record.version + 1,
      binding: record.binding,
      sha256: sha256(body),
      body,
    };
    const save = (name: keyof typeof keys, body: object) =>
      post(name, '/runtime/v1/checkpoints', body);
    await save('b', next).expect(403, { error: 'RUNTIME_LEASE_REQUIRED' });
    await save('foreign', next).expect(403, { error: 'RUNTIME_LEASE_REQUIRED' });
    // A stale writer: an old version, a skipped version, or an old lease session.
    await save('a', { ...next, version: record.version }).expect(409, {
      error: 'CHECKPOINT_VERSION_CONFLICT',
    });
    await save('a', { ...next, version: record.version + 2 }).expect(409, {
      error: 'CHECKPOINT_VERSION_CONFLICT',
    });
    await save('a', { ...next, sessionId: randomUUID() }).expect(409, {
      error: 'CHECKPOINT_SESSION_STALE',
    });
    // The body must be what its digest says, and bound to this run and its manifest.
    await save('a', { ...next, body: `${body} ` }).expect(400, {
      error: 'CHECKPOINT_DIGEST_MISMATCH',
    });
    for (const binding of [
      { ...record.binding, manifestDigest: 'a'.repeat(64) },
      { ...record.binding, manifestId: 'manifest_other' },
      { ...record.binding, workflow: 'validate-story' },
      { ...record.binding, runtimeSequence: 9999 },
      { ...record.binding, stepId: randomUUID() },
      { ...record.binding, approvalId: randomUUID() },
    ])
      await save('a', { ...next, binding }).expect(409, { error: 'CHECKPOINT_BINDING_MISMATCH' });
    await save('a', {
      ...next,
      correlation: { ...correlation, organizationId: otherAdmin.organizationId },
    }).expect(409, { error: 'RUNTIME_CORRELATION_MISMATCH' });
    await save('a', { ...next, extra: true }).expect(400);
    // Nothing above was stored; the next version in order is.
    expect((await checkpoints(run.id)).at(-1)!['version']).toBe(record.version);
    await save('a', next).expect(201, { runId: run.id, version: record.version + 1 });
    await save('a', next).expect(409, { error: 'CHECKPOINT_VERSION_CONFLICT' });

    // Forced row-level security: only the run's tenant sees the rows.
    expect(
      await raw()
        .prepare(
          `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='agent_run_checkpoints'`,
        )
        .all(),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, policies: 1 }]);
    const visible = (organizationId: string) =>
      db.store.tenant(organizationId, () =>
        db.store.all('SELECT version FROM agent_run_checkpoints'),
      );
    expect((await visible(admin.organizationId)).length).toBeGreaterThan(0);
    expect(await visible(otherAdmin.organizationId)).toEqual([]);
    expect(
      await db.store.tenant(otherAdmin.organizationId, () =>
        db.store.run('DELETE FROM agent_run_checkpoints'),
      ),
    ).toEqual({ changes: 0 });
    await expect(
      db.store.tenant(otherAdmin.organizationId, () =>
        db.store.run(
          `INSERT INTO agent_run_checkpoints SELECT * FROM agent_run_checkpoints WHERE false`,
        ),
      ),
    ).resolves.toEqual({ changes: 0 });
    await expect(
      db.store.tenant(otherAdmin.organizationId, () =>
        db.store.run(
          `INSERT INTO agent_run_checkpoints (organization_id,run_id,version,thread_id,session_id,runtime_id,
           manifest_id,manifest_digest,kernel_id,runtime_sequence,body_sha256,body_bytes,body,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,now())`,
          admin.organizationId,
          run.id,
          record.version + 2,
          run.threadId,
          sessionId,
          'runtime-a',
          record.binding.manifestId,
          record.binding.manifestDigest,
          'native-v1',
          0,
          sha256('{}'),
          2,
          '{}',
        ),
      ),
    ).rejects.toThrow();
    // Stored rows cannot be rewritten in place, by anyone.
    await expect(
      raw().prepare("UPDATE agent_run_checkpoints SET body='{}' WHERE run_id=?").run(run.id),
    ).rejects.toThrow(/CHECKPOINT_IMMUTABLE/);

    // No secret reaches a checkpoint, an event or the audit trail.
    await approve(run.id);
    await runtimeA.pollOnce();
    await runtimeA.drain();
    expect(jira).toHaveLength(1);
    const stored = JSON.stringify([
      await raw().prepare('SELECT * FROM agent_events').all(),
      await raw().prepare('SELECT * FROM audit_events').all(),
      await raw().prepare('SELECT * FROM agent_run_checkpoints').all(),
    ]);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(MODEL_KEY);
  }, 60_000);

  it('fails closed when the stored checkpoint was altered', async () => {
    const run = await startRun();
    const runtimeA = runtime('a');
    await runtimeA.pollOnce();
    await runtimeA.drain();
    // Replace the latest checkpoint with one whose body no longer matches its digest.
    const [latest] = (await checkpoints(run.id)).slice(-1);
    await raw().prepare('DELETE FROM agent_run_checkpoints WHERE run_id=?').run(run.id);
    const columns = Object.keys(latest!);
    await raw()
      .prepare(
        `INSERT INTO agent_run_checkpoints (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      )
      .run(
        ...columns.map((column) =>
          column === 'version'
            ? 1
            : column === 'body'
              ? String(latest!['body']).replace('Cart total', 'Card total')
              : (latest![column] as string | number | null),
        ),
      );
    await approve(run.id);
    await expireLease(run.id);
    await post('b', '/runtime/v1/commands/claim').expect(200);
    await post('b', '/runtime/v1/checkpoints/load', {
      protocol: 'agents-foundry/runtime/v1',
      correlation: correlationOf(run),
    }).expect(409, { error: 'CHECKPOINT_CORRUPT' });

    // A runtime given that run fails it instead of acting on the altered state.
    await raw()
      .prepare('UPDATE agent_run_leases SET last_command=NULL, heartbeat_at=? WHERE run_id=?')
      .run(new Date(Date.now() - 120_000).toISOString(), run.id);
    const runtimeB = runtime('b');
    expect(await runtimeB.pollOnce()).toBe(true);
    await runtimeB.drain();
    const detail = await db.execution.getRun(employee, run.id);
    expect(detail.run).toMatchObject({
      status: 'FAILED',
      statusReason: 'RUNTIME_CHECKPOINT_INVALID',
    });
    expect(jira).toHaveLength(0);
  }, 60_000);

  it('reaps abandoned runs nothing can continue, and stops endless recovery', async () => {
    // A run that started but was never checkpointed cannot be continued by anyone.
    const first = await startRun();
    const claim = (await post('a', '/runtime/v1/commands/claim').expect(200)).body;
    await post('a', '/runtime/v1/events', {
      protocol: 'agents-foundry/runtime/v1',
      eventId: randomUUID(),
      runId: first.id,
      threadId: first.threadId,
      sequence: 1,
      type: 'run.started',
      occurredAt: new Date().toISOString(),
      correlation: correlationOf(first),
      payload: { runtimeSessionId: claim.lease.sessionId, kernel: 'test' },
    }).expect(201);
    // A heartbeat from its holder keeps it; anyone else is told it is not theirs.
    const beat = { protocol: 'agents-foundry/runtime/v1', runIds: [first.id] };
    await post('a', '/runtime/v1/heartbeat', beat).expect(200, { held: [first.id], lost: [] });
    await post('b', '/runtime/v1/heartbeat', beat).expect(200, { held: [], lost: [first.id] });
    expect(await db.runtimeTransport.reapAbandoned()).toBe(0);
    await expireLease(first.id);
    await post('a', '/runtime/v1/heartbeat', beat).expect(200, { held: [first.id], lost: [] });
    expect(await db.runtimeTransport.reapAbandoned()).toBe(0);
    await expireLease(first.id);
    expect(await db.runtimeTransport.reapAbandoned()).toBe(1);
    expect((await db.execution.getRun(employee, first.id)).run).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'RUNTIME_LOST',
    });
    expect((await lease(first.id))!['state']).toBe('CLOSED');
    await post('a', '/runtime/v1/heartbeat', beat).expect(200, { held: [], lost: [first.id] });

    // A checkpointed run is kept for another runtime, but not for ever.
    const { run, runtimeA, release } = await abandonAfterTheDefect();
    await expireLease(run.id);
    expect(await db.runtimeTransport.reapAbandoned()).toBe(0);
    expect((await db.execution.getRun(employee, run.id)).run.status).toBe('RUNNING');
    // A run that keeps killing its runtimes is cancelled instead of handed on again.
    await raw().prepare('UPDATE agent_run_leases SET recoveries=3 WHERE run_id=?').run(run.id);
    await post('b', '/runtime/v1/commands/claim').expect(204);
    expect((await db.execution.getRun(employee, run.id)).run).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'RUNTIME_RECOVERY_EXHAUSTED',
    });
    expect(await checkpoints(run.id)).toEqual([]);
    release();
    await runtimeA.drain();

    // And one that no runtime picks up within the recovery window is cancelled too.
    const third = await abandonAfterTheDefect();
    await expireLease(third.run.id, 25 * 60 * 60_000);
    await raw()
      .prepare('UPDATE agent_runs SET updated_at=? WHERE id=?')
      .run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), third.run.id);
    expect(await db.runtimeTransport.reapAbandoned()).toBe(1);
    expect((await db.execution.getRun(employee, third.run.id)).run).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'RUNTIME_LOST',
    });
    third.release();
    await third.runtimeA.drain();
    expect(jira).toHaveLength(2);
  }, 90_000);
});
