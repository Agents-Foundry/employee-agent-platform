import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@agents-foundry/contracts';
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
import {
  ControlPlaneModelCredentials,
  ModelGateway,
  type ModelCredential,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../../agent-runtime/src/models/model-gateway.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import { ArtifactTool } from '../../agent-runtime/src/tools/artifact-tool.js';
import { ControlPlaneArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { ControlPlaneCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { MemoryArtifactStore } from '../src/artifacts/artifact-store.js';
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
const KEY = 'sk-org-alpha-model-key-9f8e7d6c5b4a';
const ROTATED = 'sk-org-alpha-rotated-key-1a2b3c4d5e';
const BETA_KEY = 'sk-org-beta-model-key-0000111122';
const runtime = runtimeKeyPair();
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A provider that records the key it was called with, and writes one report. */
class RecordingProvider implements ModelProvider {
  readonly id = 'test-provider';
  readonly keys: string[] = [];
  async complete(request: ModelRequest, credential: ModelCredential): Promise<ModelResponse> {
    this.keys.push(credential.apiKey);
    const usage = { inputTokens: 1, outputTokens: 1 };
    const answered = request.messages.some((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    );
    return answered
      ? { content: [{ type: 'text', text: 'Report stored.' }], stopReason: 'end_turn', usage }
      : {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'artifact',
              input: {
                name: 'plan.md',
                type: 'report',
                mediaType: 'text/markdown',
                content: '# Plan',
              },
            },
          ],
          stopReason: 'tool_use',
          usage,
        };
  }
}

describe('organization-managed model credentials (ADR 0034)', () => {
  let hash: string;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: Actor;
  let employee: Actor;
  let otherAdmin: Actor;
  let secrets: MemorySecretStore;
  let artifactStore: MemoryArtifactStore;
  const sessions = new Map<string, string>();

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });

  beforeEach(async () => {
    secrets = new MemorySecretStore();
    artifactStore = new MemoryArtifactStore();
    db = await testDatabase({
      seedDemo: false,
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      artifactStore,
      runtimeIdentities: [
        {
          id: 'runtime-m',
          publicKeySpki: runtime.spki,
          organizations: ['*'],
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
    secrets.set(admin.organizationId, 'model-key', KEY);
    secrets.set(admin.organizationId, 'model-key-2', ROTATED);
    secrets.set(otherAdmin.organizationId, 'model-key', BETA_KEY);
    sessions.clear();
    for (const actor of [admin, employee, otherAdmin]) {
      const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
      await db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
      sessions.set(actor.id, `af_session=${token}`);
    }
  });
  afterEach(() => db.close());

  const raw = () => rawSql(db);
  const call = (method: 'get' | 'post' | 'put', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', sessions.get(actor.id)!)
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };
  const post = (path: string, body?: unknown) =>
    signedRuntimePost(app, 'runtime-m', runtime.privateKey, path, body);
  const bind = (actor: Actor, body: object, provider = 'test-provider') =>
    call('put', `/api/organization/model-credentials/${provider}`, actor, body);

  const createAgent = async (credentialMode = 'ORGANIZATION_MANAGED') => {
    const [assignment] = (
      await call('post', '/api/organization/agents', admin, {
        requestId: randomUUID(),
        name: 'Checkout QA agent',
        employeeIds: [employee.id],
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode,
        answers,
      }).expect(201)
    ).body;
    return assignment.agentId as string;
  };
  const startRun = async (agentId: string) =>
    (
      await call('post', '/api/execution/v1/runs', employee, {
        agentId,
        task: { objective: 'Write the plan', inputs: {} },
      }).expect(202)
    ).body as { id: string; threadId: string };
  /** Claims the run and starts it, as a runtime would. */
  const held = async (agentId: string) => {
    const run = await startRun(agentId);
    const claim = (await post('/runtime/v1/commands/claim').expect(200)).body;
    const correlation = {
      organizationId: admin.organizationId,
      employeeId: employee.id,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    await post('/runtime/v1/events', {
      protocol: 'agents-foundry/runtime/v1',
      eventId: randomUUID(),
      runId: run.id,
      threadId: run.threadId,
      sequence: 1,
      type: 'run.started',
      occurredAt: new Date().toISOString(),
      correlation,
      payload: { runtimeSessionId: claim.lease.sessionId, kernel: 'test' },
    }).expect(201);
    const credential = (provider = 'test-provider', scope: object = {}) =>
      post('/runtime/v1/models/credential', {
        protocol: 'agents-foundry/runtime/v1',
        correlation: { ...correlation, ...scope },
        provider,
      });
    return { run, correlation, credential };
  };

  it('stores references only, for administrators of the organization', async () => {
    const created = (await bind(admin, { secretRef: 'secret://model-key' }).expect(200)).body;
    expect(created).toMatchObject({
      provider: 'test-provider',
      secretRef: 'secret://model-key',
      status: 'ACTIVE',
      version: 1,
    });
    // A raw key, another scheme or a path is not a reference.
    for (const secretRef of [KEY, 'env://MODEL_KEY', 'secret://../x', 'secret://', 'vault://x'])
      await bind(admin, { secretRef, version: 1 }).expect(400);
    await bind(admin, { secretRef: 'secret://model-key', extra: KEY, version: 1 }).expect(400);
    await bind(admin, { secretRef: 'secret://model-key' }, 'bad provider').expect(400);
    await bind(employee, { secretRef: 'secret://model-key', version: 1 }).expect(403);
    // Replacing needs the current version.
    await bind(admin, { secretRef: 'secret://model-key-2' }).expect(409);
    await bind(admin, { secretRef: 'secret://model-key-2', version: 7 }).expect(409);
    expect(
      (await bind(admin, { secretRef: 'secret://model-key-2', version: 1 }).expect(200)).body,
    ).toMatchObject({ secretRef: 'secret://model-key-2', version: 2 });

    // Each organization sees and changes only its own.
    expect(
      (await call('get', '/api/organization/model-credentials', otherAdmin).expect(200)).body,
    ).toEqual([]);
    await call('post', '/api/organization/model-credentials/test-provider/disable', otherAdmin, {
      version: 2,
    }).expect(404);
    await call('get', '/api/organization/model-credentials', employee).expect(403);
    const disabled = (
      await call('post', '/api/organization/model-credentials/test-provider/disable', admin, {
        version: 2,
      }).expect(200)
    ).body;
    expect(disabled).toMatchObject({ status: 'DISABLED', version: 3 });

    // PostgreSQL holds no key, and the table is under forced row-level security.
    const stored = JSON.stringify([
      await raw().prepare('SELECT * FROM organization_model_credentials').all(),
      await raw().prepare('SELECT * FROM audit_events').all(),
    ]);
    for (const secret of [KEY, ROTATED, BETA_KEY]) expect(stored).not.toContain(secret);
    expect(
      await raw()
        .prepare(
          `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='organization_model_credentials'`,
        )
        .all(),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, policies: 1 }]);
    const visible = (organizationId: string) =>
      db.store.tenant(organizationId, () =>
        db.store.all('SELECT provider FROM organization_model_credentials'),
      );
    expect(await visible(admin.organizationId)).toHaveLength(1);
    expect(await visible(otherAdmin.organizationId)).toEqual([]);
    expect(
      await db.store.tenant(otherAdmin.organizationId, () =>
        db.store.run("UPDATE organization_model_credentials SET status='ACTIVE'"),
      ),
    ).toEqual({ changes: 0 });
    await expect(
      db.store.tenant(otherAdmin.organizationId, () =>
        db.store.run(
          `INSERT INTO organization_model_credentials (organization_id,provider,secret_ref,status,version,
           created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'ACTIVE',1,?,now(),?,now())`,
          admin.organizationId,
          'other-provider',
          'secret://model-key',
          admin.id,
          admin.id,
        ),
      ),
    ).rejects.toThrow();
    await expect(raw().prepare('DELETE FROM organization_model_credentials').run()).rejects.toThrow(
      /MODEL_CREDENTIAL_RETAINED/,
    );
  });

  it('gives the key only to the runtime holding a running run that names the provider', async () => {
    await bind(admin, { secretRef: 'secret://model-key' }).expect(200);
    await bind(otherAdmin, { secretRef: 'secret://model-key' }).expect(200);
    const agentId = await createAgent();
    const { run, correlation, credential } = await held(agentId);
    const issued = await credential().expect(200);
    expect(issued.body).toEqual({ provider: 'test-provider', apiKey: KEY });
    expect(issued.headers['cache-control']).toBe('no-store');

    // A provider the signed manifest does not name, and correlations that are not the run's.
    await credential('anthropic').expect(409, { error: 'MODEL_PROVIDER_MISMATCH' });
    await credential('test-provider', { organizationId: otherAdmin.organizationId }).expect(409, {
      error: 'RUNTIME_CORRELATION_MISMATCH',
    });
    await credential('test-provider', { runId: randomUUID() }).expect(403, {
      error: 'RUNTIME_LEASE_REQUIRED',
    });
    await post('/runtime/v1/models/credential', {
      protocol: 'agents-foundry/runtime/v1',
      correlation,
      provider: 'test-provider',
      secretRef: 'secret://model-key',
    }).expect(400);
    // Unsigned, and browser-authenticated, requests get nothing.
    await request(app)
      .post('/runtime/v1/models/credential')
      .send({ protocol: 'agents-foundry/runtime/v1', correlation, provider: 'test-provider' })
      .expect(401);
    await call('post', '/runtime/v1/models/credential', admin, {
      protocol: 'agents-foundry/runtime/v1',
      correlation,
      provider: 'test-provider',
    }).expect(401);

    // Rotation and disabling take effect on the next call: nothing is cached.
    await bind(admin, { secretRef: 'secret://model-key-2', version: 1 }).expect(200);
    expect((await credential().expect(200)).body.apiKey).toBe(ROTATED);
    await bind(admin, { secretRef: 'secret://missing', version: 2 }).expect(200);
    await credential().expect(409, { error: 'SECRET_UNRESOLVED' });
    await call('post', '/api/organization/model-credentials/test-provider/disable', admin, {
      version: 3,
    }).expect(200);
    await credential().expect(409, { error: 'MODEL_CREDENTIAL_NOT_CONFIGURED' });
    await bind(admin, { secretRef: 'secret://model-key', version: 4 }).expect(200);
    await credential().expect(200);

    // A run that is no longer running gets nothing.
    await call('post', `/api/execution/v1/runs/${run.id}/cancel`, employee).expect(200);
    await credential().expect(409);

    const audit = await raw()
      .prepare(
        "SELECT event_type, metadata FROM audit_events WHERE event_type LIKE 'runtime.model.credential.%' ORDER BY seq",
      )
      .all();
    expect(audit.map((event) => event['event_type'])).toEqual([
      'runtime.model.credential.issued',
      'runtime.model.credential.refused',
      'runtime.model.credential.issued',
      'runtime.model.credential.refused',
      'runtime.model.credential.refused',
      'runtime.model.credential.issued',
    ]);
    const everything = JSON.stringify([
      await raw().prepare('SELECT * FROM audit_events').all(),
      await raw().prepare('SELECT * FROM agent_events').all(),
      await raw().prepare('SELECT * FROM agent_runs').all(),
    ]);
    for (const secret of [KEY, ROTATED, BETA_KEY]) expect(everything).not.toContain(secret);
  });

  it('still fails closed for employee-held keys', async () => {
    await bind(admin, { secretRef: 'secret://model-key' }).expect(200);
    const agentId = await createAgent('EMPLOYEE_BYOK');
    const { credential } = await held(agentId);
    await credential().expect(409, { error: 'MODEL_CREDENTIAL_UNAVAILABLE' });
    // The runtime's own broker refuses before asking at all.
    let asked = 0;
    const broker = new ControlPlaneModelCredentials(async () => {
      asked += 1;
      return { apiKey: KEY };
    });
    await expect(
      broker.resolve({
        organizationId: admin.organizationId,
        employeeId: employee.id,
        provider: 'test-provider',
        credentialMode: 'EMPLOYEE_BYOK',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL_UNAVAILABLE' });
    expect(asked).toBe(0);
  });

  it('runs a real runtime on the brokered key without the key reaching any durable record', async () => {
    await bind(admin, { secretRef: 'secret://model-key' }).expect(200);
    const agentId = await createAgent();
    const run = await startRun(agentId);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const controlPlane = new ControlPlaneClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        runtimeId: 'runtime-m',
        privateKey: runtime.privateKey,
      });
      const provider = new RecordingProvider();
      const host = new RuntimeHost({
        controlPlane,
        verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
        kernel: new NativeKernel(),
        // No key of its own: without the control plane the runtime could not call the model.
        models: new ModelGateway([provider], {
          resolve: async () => {
            throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
          },
        }),
        modelCredentials: (correlation) =>
          new ControlPlaneModelCredentials(async (name) => ({
            apiKey: (
              await controlPlane.modelCredential({
                protocol: 'agents-foundry/runtime/v1',
                correlation,
                provider: name,
              })
            ).apiKey,
          })),
        tools: new ToolRegistry([new ArtifactTool()]),
        artifacts: new ControlPlaneArtifactStore(controlPlane),
        checkpoints: new ControlPlaneCheckpointStore(controlPlane),
        logger: silent,
      });
      // Keep the checkpoints so their contents can be inspected after the run.
      const saved: string[] = [];
      const save = controlPlane.saveCheckpoint.bind(controlPlane);
      controlPlane.saveCheckpoint = async (checkpoint) => {
        saved.push(checkpoint.body);
        return save(checkpoint);
      };
      expect(await host.pollOnce()).toBe(true);
      await host.drain();
      const detail = await db.execution.getRun(employee, run.id);
      expect(detail.run.status).toBe('COMPLETED');
      expect(provider.keys).toEqual([KEY, KEY]);
      // The report went to the control plane's artifact store, not to the runtime's disk.
      expect(detail.artifacts).toEqual([
        expect.objectContaining({
          name: 'plan.md',
          content: expect.objectContaining({ state: 'AVAILABLE' }),
        }),
      ]);
      expect(artifactStore.objects.size).toBe(1);
      expect([...artifactStore.objects.values()][0]!.toString()).toBe('# Plan');
      expect(saved.length).toBeGreaterThan(2);

      const durable = JSON.stringify([
        saved,
        [...artifactStore.objects.values()].map((bytes) => bytes.toString('utf8')),
        await raw().prepare('SELECT * FROM agent_events').all(),
        await raw().prepare('SELECT * FROM audit_events').all(),
        await raw().prepare('SELECT * FROM agent_artifacts').all(),
        await raw().prepare('SELECT * FROM agent_artifact_objects').all(),
        await raw().prepare('SELECT * FROM agent_runs').all(),
        await raw().prepare('SELECT * FROM agent_run_steps').all(),
        await raw()
          .prepare('SELECT * FROM agent_manifests')
          .all()
          .catch(() => []),
        await db.getManifest(agentId, admin.organizationId, employee.id),
      ]);
      expect(durable).not.toContain(KEY);
      expect(durable).toContain('secret://model-key');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);
});
