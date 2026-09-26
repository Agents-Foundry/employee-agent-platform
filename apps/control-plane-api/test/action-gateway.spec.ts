import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@agents-foundry/contracts';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { FileSecretStore, MemorySecretStore } from '../src/actions/secrets.js';
import { JiraIssueTrackerConnector } from '../src/actions/connectors/jira.js';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import { evaluateActionPolicy } from '../../../packages/policy-engine/src/index.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import { IssueTrackerTool } from '../../agent-runtime/src/tools/issue-tracker-tool.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../agent-runtime/src/checkpoints.js';

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
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalManifest(value)).digest('hex');
const runtime = runtimeKeyPair();
const TOKEN = 'jira-api-token-value';

interface JiraCall {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

describe('Action Gateway', () => {
  let hash: string;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: Actor;
  let employee: Actor;
  let otherAdmin: Actor;
  let secrets: MemorySecretStore;
  let jira: JiraCall[];
  let jiraStatus: number;

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });

  beforeEach(() => {
    secrets = new MemorySecretStore();
    jira = [];
    jiraStatus = 201;
    db = new ControlPlaneDatabase(':memory:', false, {
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      connectorFetch: async (url, init) => {
        jira.push({
          url: String(url),
          authorization: String((init!.headers as Record<string, string>)['authorization']),
          body: JSON.parse(String(init!.body)),
        });
        return jiraStatus === 201
          ? Response.json({ id: '10001', key: 'QA-42' }, { status: 201 })
          : new Response(`{"errorMessages":["token ${TOKEN} rejected"]}`, { status: jiraStatus });
      },
      runtimeIdentities: [
        {
          id: 'runtime-gw',
          publicKeySpki: runtime.spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    app = createApp(db, config);
    const tenant = (name: string) => {
      const org = db.createCustomer(
        { name, slug: name.toLowerCase() },
        { displayName: 'Admin', email: `admin@${name}.example`, team: 'Admin' },
      );
      db.acceptInvitation(hashToken(org.token), hash);
      return { id: org.employeeId, organizationId: org.organizationId, role: 'ADMIN' as const };
    };
    admin = tenant('Alpha');
    otherAdmin = tenant('Beta');
    const invitation = db.inviteEmployee(admin, {
      displayName: 'Quinn',
      email: 'quinn@alpha.example',
      team: 'QA',
    });
    db.acceptInvitation(hashToken(invitation.token), hash);
    employee = {
      id: invitation.employeeId,
      organizationId: admin.organizationId,
      role: 'EMPLOYEE',
    };
    secrets.set(admin.organizationId, 'jira-token', TOKEN);
  });
  afterEach(() => db.close());

  const raw = () => (db as unknown as { db: DatabaseSync }).db;
  const cookie = (actor: Actor) => {
    const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
    db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
    return `af_session=${token}`;
  };
  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    actor: Actor,
    body?: object,
  ) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', cookie(actor))
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };
  const post = (path: string, body?: unknown) =>
    signedRuntimePost(app, 'runtime-gw', runtime.privateKey, path, body);

  const connect = (actor = admin, overrides: object = {}) =>
    call('post', '/api/organization/connector-connections', actor, {
      provider: 'jira',
      name: 'Alpha Jira',
      baseUrl: 'https://alpha.atlassian.net',
      secretRef: 'secret://jira-token',
      settings: { authEmail: 'bot@alpha.example', allowedProjects: ['QA'] },
      ...overrides,
    });

  const createAgent = async (blueprintVersion = '1.2.0') => {
    const [assignment] = (
      await call('post', '/api/organization/agents', admin, {
        requestId: randomUUID(),
        name: 'Checkout QA agent',
        employeeIds: [employee.id],
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion,
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers,
      }).expect(201)
    ).body;
    return assignment.agentId as string;
  };

  /** Starts a run as the employee, claims it, and opens one RUNNING tool step. */
  const runningStep = async (agentId: string) => {
    const run = (
      await call('post', '/api/execution/v1/runs', employee, {
        agentId,
        task: { objective: 'Validate STORY-12', inputs: {} },
      }).expect(202)
    ).body as { id: string; threadId: string };
    const claim = (await post('/runtime/v1/commands/claim').expect(200)).body;
    expect(claim.command.run.runId).toBe(run.id);
    const correlation = {
      organizationId: admin.organizationId,
      employeeId: employee.id,
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
    await emit('step.started', { kind: 'TOOL', title: 'File defect' }, stepId).expect(201);
    const toolCallId = randomUUID();
    const action = (overrides: object = {}, parameters: unknown = draft) => ({
      protocol: 'agents-foundry/runtime/v1',
      requestId: randomUUID(),
      correlation: { ...correlation, stepId, toolCallId },
      action: 'jira.issue.create',
      toolId: 'issue-tracker',
      toolVersion: '1.0.0',
      inputDigest: digest(parameters ?? {}),
      summary: 'model-written summary',
      ...(parameters === null ? {} : { parameters }),
      ...overrides,
    });
    const execute = (requestId: string) =>
      post('/runtime/v1/actions/execute', {
        protocol: 'agents-foundry/runtime/v1',
        requestId,
        correlation: { ...correlation, stepId, toolCallId },
      });
    return { run, stepId, emit, action, execute };
  };

  describe('administration', () => {
    it('stores connector references only, validates URLs and is tenant-admin only', async () => {
      const created = (await connect().expect(201)).body;
      expect(created).toMatchObject({
        provider: 'jira',
        baseUrl: 'https://alpha.atlassian.net',
        secretRef: 'secret://jira-token',
        status: 'ACTIVE',
        version: 1,
      });
      await connect().expect(409, { error: 'CONNECTION_ALREADY_ACTIVE' });
      for (const baseUrl of [
        'http://alpha.atlassian.net',
        'https://127.0.0.1',
        'https://[::1]',
        'https://localhost',
        'https://jira.internal',
        'https://user:pass@alpha.atlassian.net',
        'https://alpha.atlassian.net/?x=1',
        'not a url',
      ])
        await connect(admin, { baseUrl, name: 'Other' }).expect(400);
      for (const secretRef of [TOKEN, 'env://JIRA', 'secret://../x', 'secret://'])
        await connect(admin, { secretRef }).expect(400);
      await connect(admin, { settings: { allowedProjects: ['qa'] } }).expect(400);
      await call('get', '/api/organization/connector-connections', employee).expect(403);
      expect(
        (await call('get', '/api/organization/connector-connections', otherAdmin).expect(200)).body,
      ).toEqual([]);
      await call(
        'post',
        `/api/organization/connector-connections/${created.id}/disable`,
        otherAdmin,
        {
          version: 1,
        },
      ).expect(404);
      await call('post', `/api/organization/connector-connections/${created.id}/disable`, admin, {
        version: 9,
      }).expect(409);
      const disabled = (
        await call('post', `/api/organization/connector-connections/${created.id}/disable`, admin, {
          version: 1,
        }).expect(200)
      ).body;
      expect(disabled).toMatchObject({ status: 'DISABLED', version: 2 });
      expect(
        JSON.stringify(raw().prepare('SELECT * FROM organization_connector_connections').all()),
      ).not.toContain(TOKEN);
      expect(JSON.stringify(raw().prepare('SELECT * FROM audit_events').all())).not.toContain(
        TOKEN,
      );
      const demo = new ControlPlaneDatabase(':memory:');
      try {
        await request(createApp(demo, { mode: 'demo' }))
          .get('/api/organization/connector-connections')
          .set({
            'x-actor-id': 'admin_demo',
            'x-actor-role': 'ADMIN',
            'x-organization-id': 'org_agents_foundry',
          })
          .expect(404);
      } finally {
        demo.close();
      }
    });

    it('lists governed actions and accepts tighten-only organization overrides', async () => {
      const listed = (await call('get', '/api/organization/action-policies', admin).expect(200))
        .body;
      expect(listed).toContainEqual(
        expect.objectContaining({
          action: 'jira.issue.create',
          defaultOutcome: 'REQUIRE_APPROVAL',
          executedBy: 'CONTROL_PLANE',
          connectorProvider: 'jira',
          override: null,
        }),
      );
      expect(listed).toContainEqual(
        expect.objectContaining({ action: 'repository.read', executedBy: 'RUNTIME' }),
      );
      await call('put', '/api/organization/action-policies/repository.read', admin, {
        outcome: 'ALLOW',
        reason: 'loosen',
      }).expect(400);
      await call('put', '/api/organization/action-policies/bank.transfer', admin, {
        outcome: 'DENY',
        reason: 'x',
      }).expect(404);
      await call('put', '/api/organization/action-policies/repository.read', employee, {
        outcome: 'DENY',
        reason: 'x',
      }).expect(403);
      const set = (
        await call('put', '/api/organization/action-policies/repository.read', admin, {
          outcome: 'REQUIRE_APPROVAL',
          reason: 'Source is confidential this quarter.',
        }).expect(200)
      ).body;
      expect(set).toMatchObject({ action: 'repository.read', outcome: 'REQUIRE_APPROVAL' });
      expect(db.actionPolicies.outcome(otherAdmin.organizationId, 'repository.read')).toBeNull();
      await call('delete', '/api/organization/action-policies/repository.read', admin).expect(204);
      await call('delete', '/api/organization/action-policies/repository.read', admin).expect(404);
    });
  });

  describe('decisions and execution', () => {
    it('denies requests that are unconfigured, out of scope, mismatched or under-granted', async () => {
      const agentId = await createAgent();
      const { action } = await runningStep(agentId);
      const decide = async (body: object) =>
        (await post('/runtime/v1/actions', body).expect(200)).body;
      expect(await decide(action())).toMatchObject({
        decision: 'DENIED',
        reason: 'CONNECTOR_NOT_CONFIGURED',
      });
      await connect().expect(201);
      expect(await decide(action({}, null))).toMatchObject({ reason: 'PARAMETERS_REQUIRED' });
      expect(await decide(action({}, { ...draft, issueType: 'Epic' }))).toMatchObject({
        reason: 'PARAMETERS_INVALID',
      });
      expect(await decide(action({ inputDigest: 'f'.repeat(64) }))).toMatchObject({
        reason: 'INPUT_DIGEST_MISMATCH',
      });
      expect(await decide(action({}, { ...draft, projectKey: 'FIN' }))).toMatchObject({
        decision: 'DENIED',
        reason: 'The target resource is outside the configured scope.',
      });

      const older = await createAgent('1.1.0');
      const second = await runningStep(older);
      expect(await decide(second.action())).toMatchObject({
        decision: 'DENIED',
        reason: 'CONNECTOR_CAPABILITY_MISSING',
      });
      const stored = raw()
        .prepare("SELECT policy_id, parameters FROM agent_action_requests WHERE decision='DENIED'")
        .all();
      expect(stored.every((row) => row['parameters'] === null)).toBe(true);
    });

    it('allows work-item reads in configured projects with read capability only', async () => {
      await connect().expect(201);
      const decide = async (body: object) =>
        (await post('/runtime/v1/actions', body).expect(200)).body;
      const read = (step: Awaited<ReturnType<typeof runningStep>>, issueKey: string) =>
        step.action({ action: 'jira.read' }, { issueKey });
      const current = await runningStep(await createAgent());
      expect(await decide(read(current, 'FIN-1'))).toMatchObject({
        decision: 'DENIED',
        reason: 'The target resource is outside the configured scope.',
      });
      expect(
        await decide(current.action({ action: 'jira.read' }, { issueKey: 'QA-1', x: 1 })),
      ).toMatchObject({ reason: 'PARAMETERS_INVALID' });
      // QA Engineer 1.1.0 has issueTracker.read but not write: reading is still allowed.
      const older = await runningStep(await createAgent('1.1.0'));
      expect(await decide(read(older, 'QA-1'))).toMatchObject({ decision: 'ALLOWED' });
      expect(
        raw()
          .prepare("SELECT action, parameters FROM agent_action_requests WHERE decision='ALLOWED'")
          .all(),
      ).toEqual([{ action: 'jira.read', parameters: '{"issueKey":"QA-1"}' }]);
    });

    it('pauses with a payload-bound expiring approval, then executes exactly once after approval', async () => {
      await connect().expect(201);
      const agentId = await createAgent();
      const { run, stepId, emit, action, execute } = await runningStep(agentId);
      const request = action();
      const decision = (await post('/runtime/v1/actions', request).expect(200)).body;
      expect(decision).toMatchObject({ decision: 'APPROVAL_REQUIRED', risk: 'MEDIUM' });
      const approvals = (await call('get', '/api/approvals', admin).expect(200)).body;
      const approval = approvals.find((item: { id: string }) => item.id === decision.approvalId);
      expect(approval).toMatchObject({
        action: 'jira.issue.create',
        resourceType: 'issue-tracker.project',
        resourceId: 'QA',
        summary: 'Create Jira bug in QA: Cart total ignores the discount',
        status: 'PENDING',
        runId: run.id,
        stepId,
      });
      const ttl = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt);
      expect(ttl).toBe(24 * 3600 * 1000);
      expect(
        raw()
          .prepare('SELECT policy_id, policy_version FROM agent_action_requests WHERE id=?')
          .get(request.requestId),
      ).toEqual({ policy_id: 'agents-foundry.foundation', policy_version: 'foundation-v2' });

      // Paused runs cannot execute; nothing reaches Jira before a human decides.
      await execute(request.requestId).expect(409, { error: 'RUN_NOT_RUNNING' });
      await call('post', `/api/approvals/${decision.approvalId}/decision`, admin, {
        decision: 'APPROVED',
      }).expect(200);
      const resume = (await post('/runtime/v1/commands/claim').expect(200)).body;
      expect(resume.command.type).toBe('run.resume');
      await emit('run.resumed', { approvalId: decision.approvalId }).expect(201);

      const executed = (await execute(request.requestId).expect(200)).body;
      expect(executed).toEqual({
        requestId: request.requestId,
        status: 'SUCCEEDED',
        result: { issueKey: 'QA-42', url: 'https://alpha.atlassian.net/browse/QA-42' },
      });
      expect(jira).toHaveLength(1);
      expect(jira[0]!.url).toBe('https://alpha.atlassian.net/rest/api/3/issue');
      expect(jira[0]!.authorization).toBe(
        `Basic ${Buffer.from(`bot@alpha.example:${TOKEN}`).toString('base64')}`,
      );
      expect(jira[0]!.body).toMatchObject({
        fields: {
          project: { key: 'QA' },
          summary: draft.summary,
          issuetype: { name: 'Bug' },
          description: { type: 'doc', version: 1 },
        },
      });
      // Single use: a retry returns the recorded outcome without calling Jira again.
      expect((await execute(request.requestId).expect(200)).body).toEqual(executed);
      expect(jira).toHaveLength(1);
      expect(() =>
        raw().prepare("UPDATE agent_action_executions SET status='FAILED'").run(),
      ).toThrow('ACTION_EXECUTION_FINAL');

      const allowed = action({ action: 'repository.read', toolId: 'repository' }, null);
      await post('/runtime/v1/actions', allowed).expect(200);
      await execute(allowed.requestId).expect(409, { error: 'ACTION_NOT_EXECUTABLE' });

      const history = JSON.stringify([
        raw().prepare('SELECT * FROM audit_events').all(),
        raw().prepare('SELECT * FROM agent_events').all(),
        raw().prepare('SELECT * FROM agent_action_executions').all(),
      ]);
      expect(history).not.toContain(TOKEN);
      expect(
        raw()
          .prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'action.%'")
          .all()
          .map((row) => row['event_type']),
      ).toEqual(['action.executed']);
    });

    it('refuses execution when policy tightens, the secret is missing or the connector fails', async () => {
      await connect().expect(201);
      const agentId = await createAgent();
      const approve = async (step: Awaited<ReturnType<typeof runningStep>>) => {
        const request = step.action();
        const decision = (await post('/runtime/v1/actions', request).expect(200)).body;
        await call('post', `/api/approvals/${decision.approvalId}/decision`, admin, {
          decision: 'APPROVED',
        }).expect(200);
        await post('/runtime/v1/commands/claim').expect(200);
        await step.emit('run.resumed', { approvalId: decision.approvalId }).expect(201);
        return request;
      };

      const first = await runningStep(agentId);
      const firstRequest = await approve(first);
      await call('put', '/api/organization/action-policies/jira.issue.create', admin, {
        outcome: 'DENY',
        reason: 'Freeze',
      }).expect(200);
      expect((await first.execute(firstRequest.requestId).expect(200)).body).toMatchObject({
        status: 'FAILED',
        error: { code: 'POLICY_DENIED' },
      });
      expect((await post('/runtime/v1/actions', first.action()).expect(200)).body).toMatchObject({
        decision: 'DENIED',
        reason: 'Restricted by organization policy.',
      });
      await call('delete', '/api/organization/action-policies/jira.issue.create', admin).expect(
        204,
      );
      await first.emit('step.completed', {}, first.stepId).expect(201);
      await first.emit('run.completed', { summary: 'x', artifactIds: [] }).expect(201);

      const second = await runningStep(agentId);
      const secondRequest = await approve(second);
      secrets = new MemorySecretStore();
      (db.actions as unknown as { deps: { secrets: MemorySecretStore } }).deps.secrets = secrets;
      expect((await second.execute(secondRequest.requestId).expect(200)).body).toMatchObject({
        status: 'FAILED',
        error: { code: 'SECRET_UNRESOLVED' },
      });
      secrets.set(admin.organizationId, 'jira-token', TOKEN);
      // Refusals are final too: the same request never dispatches later.
      expect((await second.execute(secondRequest.requestId).expect(200)).body).toMatchObject({
        error: { code: 'SECRET_UNRESOLVED' },
      });
      expect(jira).toHaveLength(0);
      await second.emit('step.completed', {}, second.stepId).expect(201);
      await second.emit('run.completed', { summary: 'x', artifactIds: [] }).expect(201);

      const third = await runningStep(agentId);
      const thirdRequest = await approve(third);
      jiraStatus = 401;
      const failed = (await third.execute(thirdRequest.requestId).expect(200)).body;
      expect(failed).toMatchObject({
        status: 'FAILED',
        error: {
          code: 'CONNECTOR_REQUEST_FAILED',
          message: 'The jira connector failed (HTTP 401).',
        },
      });
      expect(JSON.stringify(failed)).not.toContain(TOKEN);
      expect(jira).toHaveLength(1);
    });

    it('expires unanswered approvals, cancels the run and rejects late decisions', async () => {
      await connect().expect(201);
      const agentId = await createAgent();
      const { run, action } = await runningStep(agentId);
      const decision = (await post('/runtime/v1/actions', action()).expect(200)).body;
      raw()
        .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
        .run(new Date(Date.now() - 1000).toISOString(), decision.approvalId);
      await call('post', `/api/approvals/${decision.approvalId}/decision`, admin, {
        decision: 'APPROVED',
      }).expect(409, { error: 'APPROVAL_EXPIRED' });
      const listed = (await call('get', '/api/approvals', admin).expect(200)).body;
      expect(listed.find((item: { id: string }) => item.id === decision.approvalId).status).toBe(
        'EXPIRED',
      );
      const detail = db.execution.getRun(employee, run.id);
      expect(detail.run).toMatchObject({ status: 'CANCELLED', statusReason: 'APPROVAL_EXPIRED' });
      expect(detail.approvals[0]).toMatchObject({ status: 'EXPIRED' });
      const types = db.execution
        .listEvents(employee, run.id, 0, 200)
        .items.map((event) => event.type);
      expect(types.slice(-2)).toEqual(['approval.expired', 'run.cancelled']);
      expect((await post('/runtime/v1/commands/claim').expect(200)).body.command).toMatchObject({
        type: 'run.cancel',
        reason: 'APPROVAL_EXPIRED',
      });
    });
  });

  it('files a defect end to end: runtime tool, approval, gateway, Jira', async () => {
    await connect().expect(201);
    const agentId = await createAgent();
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const host = new RuntimeHost({
        controlPlane: new ControlPlaneClient({
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          runtimeId: 'runtime-gw',
          privateKey: runtime.privateKey,
        }),
        verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
        kernel: new NativeKernel(),
        models: new ModelGateway(
          [
            new ScriptedProvider('test-provider', (req) =>
              req.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
                ? {
                    content: [{ type: 'text', text: 'Filed the defect.' }],
                    stopReason: 'end_turn',
                    usage: { inputTokens: 1, outputTokens: 1 },
                  }
                : {
                    content: [
                      { type: 'tool_use', id: 'toolu_1', name: 'issue-tracker', input: draft },
                    ],
                    stopReason: 'tool_use',
                    usage: { inputTokens: 1, outputTokens: 1 },
                  },
            ),
          ],
          { resolve: async () => ({ apiKey: 'test-only' }) },
        ),
        tools: new ToolRegistry([new IssueTrackerTool()]),
        artifacts: new MemoryArtifactStore(),
        checkpoints: new MemoryCheckpointStore(),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const run = (
        await call('post', '/api/execution/v1/runs', employee, {
          agentId,
          task: { objective: 'File the checkout defect', inputs: {} },
        }).expect(202)
      ).body;
      await host.pollOnce();
      await host.drain();
      const approval = db.execution.getRun(employee, run.id).approvals[0]!;
      expect(approval.status).toBe('PENDING');
      expect(jira).toHaveLength(0);
      await call('post', `/api/approvals/${approval.id}/decision`, admin, {
        decision: 'APPROVED',
      }).expect(200);
      await host.pollOnce();
      await host.drain();
      const detail = db.execution.getRun(employee, run.id);
      expect(detail.run.status).toBe('COMPLETED');
      expect(jira).toHaveLength(1);
      expect(detail.steps.map((step) => [step.kind, step.status])).toEqual([
        ['MODEL', 'COMPLETED'],
        ['TOOL', 'COMPLETED'],
        ['MODEL', 'COMPLETED'],
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Policy v2', () => {
  const base = {
    organizationId: 'org',
    actor: { kind: 'AGENT' as const, agentId: 'a', employeeId: 'e' },
    organizationOutcome: null,
  };
  it('only ever keeps or tightens the platform decision', () => {
    expect(
      evaluateActionPolicy({ ...base, action: 'repository.read', manifestOutcome: 'ALLOW' }),
    ).toMatchObject({
      outcome: 'ALLOW',
      conditions: [],
      policyVersion: 'foundation-v2',
    });
    expect(
      evaluateActionPolicy({
        ...base,
        action: 'repository.read',
        manifestOutcome: 'ALLOW',
        organizationOutcome: 'REQUIRE_APPROVAL',
      }),
    ).toMatchObject({ outcome: 'REQUIRE_APPROVAL', reason: 'Restricted by organization policy.' });
    expect(
      evaluateActionPolicy({ ...base, action: 'repository.read', manifestOutcome: null }),
    ).toMatchObject({
      outcome: 'DENY',
    });
    // A manifest cannot loosen: production.deploy stays denied.
    expect(
      evaluateActionPolicy({ ...base, action: 'production.deploy', manifestOutcome: 'ALLOW' }),
    ).toMatchObject({
      outcome: 'DENY',
    });
    expect(
      evaluateActionPolicy({ ...base, action: 'bank.transfer', manifestOutcome: 'ALLOW' }).outcome,
    ).toBe('DENY');
    expect(
      evaluateActionPolicy({
        ...base,
        action: 'jira.issue.create',
        manifestOutcome: 'ALLOW',
        resource: { type: 'p', id: 'X', inScope: false },
      }).outcome,
    ).toBe('DENY');
    expect(
      evaluateActionPolicy({
        ...base,
        action: 'repository.pull_request.create',
        manifestOutcome: 'REQUIRE_APPROVAL',
      }).conditions,
    ).toEqual([
      { type: 'APPROVAL_TTL_SECONDS', value: 8 * 3600 },
      { type: 'BIND_TO_INPUT_DIGEST' },
    ]);
  });
});

describe('connectors and secrets', () => {
  it('scopes file secrets to the owning organization and rejects malformed references', () => {
    const directory = mkdtempSync(join(tmpdir(), 'af-secrets-'));
    try {
      const path = join(directory, 'secrets.json');
      writeFileSync(
        path,
        JSON.stringify({ org_a: { token: 'a-secret' }, org_b: { token: 'b-secret' } }),
      );
      const store = new FileSecretStore(path);
      expect(store.resolve('org_a', 'secret://token')).toBe('a-secret');
      expect(store.resolve('org_b', 'secret://token')).toBe('b-secret');
      expect(store.resolve('org_c', 'secret://token')).toBeNull();
      expect(store.resolve('org_a', 'secret://missing')).toBeNull();
      expect(store.resolve('org_a', 'token')).toBeNull();
      expect(store.resolve('org_a', 'secret://__proto__')).toBeNull();
      expect(new FileSecretStore(undefined).resolve('org_a', 'secret://token')).toBeNull();
      writeFileSync(path, '{broken');
      expect(store.resolve('org_a', 'secret://token')).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses bearer auth without an email and rejects malformed Jira responses', async () => {
    const calls: Record<string, string>[] = [];
    const connector = (body: unknown) =>
      new JiraIssueTrackerConnector({
        baseUrl: 'https://jira.example.com/',
        token: 't',
        fetch: async (_url, init) => {
          calls.push(init!.headers as Record<string, string>);
          return Response.json(body, { status: 201 });
        },
      });
    const signal = new AbortController().signal;
    const issue = { projectKey: 'QA', summary: 's', description: 'd', issueType: 'Task' as const };
    expect(await connector({ key: 'QA-1' }).createIssue(issue, signal)).toEqual({
      key: 'QA-1',
      url: 'https://jira.example.com/browse/QA-1',
    });
    expect(calls[0]!['authorization']).toBe('Bearer t');
    await expect(connector({ key: '../evil' }).createIssue(issue, signal)).rejects.toThrow(
      'CONNECTOR_RESPONSE_INVALID',
    );
  });

  it('reads a Jira issue as bounded plain text and only the issue asked for', async () => {
    const connector = (body: unknown) =>
      new JiraIssueTrackerConnector({
        baseUrl: 'https://jira.example.com',
        token: 't',
        fetch: async () => Response.json(body),
      });
    const signal = new AbortController().signal;
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const long = 'x'.repeat(3000);
    const issue = await connector({
      key: 'QA-7',
      fields: {
        summary: 'Line one\nline two',
        status: { name: 'In QA' },
        issuetype: { name: 'Story' },
        description: { type: 'doc', content: [paragraph('Given SAVE10'), paragraph(long)] },
      },
    }).getIssue('QA-7', signal);
    expect(issue).toMatchObject({
      key: 'QA-7',
      summary: 'Line one line two',
      status: 'In QA',
      issueType: 'Story',
      descriptionTruncated: true,
      url: 'https://jira.example.com/browse/QA-7',
    });
    expect(issue.description).toHaveLength(2000);
    expect(issue.description.startsWith('Given SAVE10\nxxx')).toBe(true);
    await expect(connector({ key: 'QA-8', fields: {} }).getIssue('QA-7', signal)).rejects.toThrow(
      'CONNECTOR_RESPONSE_INVALID',
    );
    await expect(connector({ key: 'QA-7', fields: {} }).getIssue('../x', signal)).rejects.toThrow(
      'CONNECTOR_REQUEST_FAILED',
    );
  });
});
