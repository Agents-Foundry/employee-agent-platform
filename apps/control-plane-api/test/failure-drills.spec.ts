import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type {
  Actor,
  ExecutionOperation,
  RuntimeArtifactUploadRequest,
} from '@agents-foundry/contracts';
import { ControlPlaneDatabase, type ControlPlaneDatabaseOptions } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { DevelopmentSecretProvider, type SecretProvider } from '../src/secrets/secret-broker.js';
import { ArtifactStoreError, MemoryArtifactStore } from '../src/artifacts/artifact-store.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { MemorySpanExporter, Telemetry } from '../../../packages/telemetry/src/index.js';
import { runtimeKeyPair } from './runtime-helpers.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import {
  ControlPlaneModelCredentials,
  ModelGateway,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../../agent-runtime/src/models/model-gateway.js';
import { ToolRegistry, type RuntimeTool } from '../../agent-runtime/src/tools/runtime-tool.js';
import type { ToolExecutionContext } from '../../agent-runtime/src/tools/runtime-tool.js';
import { ArtifactTool } from '../../agent-runtime/src/tools/artifact-tool.js';
import { IssueTrackerTool } from '../../agent-runtime/src/tools/issue-tracker-tool.js';
import { RepositoryTool } from '../../agent-runtime/src/tools/execution-tools.js';
import {
  ControlPlaneArtifactStore,
  type ArtifactTransport,
} from '../../agent-runtime/src/tools/artifact-store.js';
import { ControlPlaneCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { ExecutionService } from '../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../execution-runtime/src/artifact-store.js';
import { StateStore } from '../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../execution-runtime/src/server.js';
import type {
  ExecutionProvider,
  ProviderOutcome,
} from '../../execution-runtime/src/providers/execution-provider.js';
import { testStore, type TestStore } from './support/database.js';
import { RawSql } from './support/raw-sql.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../packages/contracts/src/runtime/v1/protocol.js';

/**
 * Failure drills (ADR 0036). Each one breaks a component at a point where a mistake would be
 * a security or integrity problem, and proves which of these the platform does: retry safely,
 * recover, reuse a recorded result, fail closed, or stop for a person to reconcile. None may
 * perform a governed external write twice.
 */

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
const report = {
  name: 'plan.md',
  type: 'report',
  mediaType: 'text/markdown',
  content: '# Plan\n\nCheck the cart total.',
};
const checkout: ExecutionOperation = {
  kind: 'git.checkout',
  repositoryUrl: 'https://example.com/repo.git',
  ref: 'main',
  path: 'repo',
};
const JIRA_TOKEN = 'jira-api-token-value-drill';
const MODEL_KEY = 'sk-drill-model-key-000111222333';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const keys = { a: runtimeKeyPair(), b: runtimeKeyPair() };
const usage = { inputTokens: 3, outputTokens: 2 };

type Call = { name: string; input: object };
type Script = (results: { content: string; isError: boolean }[]) => Call | string;

/** A model that follows a script of tool calls; any runtime can play it from any point. */
const scripted =
  (script: Script) =>
  (input: ModelRequest): ModelResponse => {
    const results = input.messages.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'tool_result' ? [{ content: block.content, isError: block.isError }] : [],
      ),
    );
    const next = script(results);
    return typeof next === 'string'
      ? { content: [{ type: 'text', text: next }], stopReason: 'end_turn', usage }
      : {
          content: [
            { type: 'tool_use', id: `toolu_${results.length}`, name: next.name, input: next.input },
          ],
          stopReason: 'tool_use',
          usage,
        };
  };
const inOrder =
  (calls: Call[], final = 'Done.'): Script =>
  (results) =>
    calls[results.length] ?? final;

/** Something a test can stop at: `wait` never resolves until `open` is called. */
const gates: (() => void)[] = [];
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  // Opened when the test ends, so a failed assertion never leaves a runtime waiting.
  gates.push(open);
  return { wait, open };
}

/** A model provider that can stop answering at a chosen call, as a dead runtime's would. */
class DrillProvider implements ModelProvider {
  readonly id = 'test-provider';
  calls = 0;
  keys: string[] = [];
  stopAt: { call: number; until: Promise<void> } | null = null;

  constructor(private readonly script: Script) {}

  async complete(input: ModelRequest, credential: { apiKey: string }): Promise<ModelResponse> {
    this.calls += 1;
    this.keys.push(credential.apiKey);
    if (this.stopAt?.call === this.calls) await this.stopAt.until;
    return scripted(this.script)(input);
  }
}

/** Wraps a tool so a test can stop the runtime just before, or just after, its work. */
function stopping<T extends object>(
  tool: T,
  stops: { before?: Promise<void>; after?: Promise<void> },
): T {
  const execute = async (input: unknown, context: ToolExecutionContext) => {
    if (stops.before) await stops.before;
    const output = await (tool as unknown as RuntimeTool).execute(input, context);
    if (stops.after) await stops.after;
    return output;
  };
  return Object.create(tool, { execute: { value: execute } }) as T;
}

/** Records what the execution runtime actually ran. */
class RecordingProvider implements ExecutionProvider {
  readonly id = 'recording';
  readonly isolation = 'local' as const;
  readonly enforces = ['timeout'] as const;
  readonly seen: ExecutionOperation[] = [];
  async execute(_workspace: unknown, operation: ExecutionOperation): Promise<ProviderOutcome> {
    this.seen.push(operation);
    return { status: 'SUCCEEDED', output: 'Checked out.', truncated: false, artifacts: [] };
  }
}

class SwitchableStore extends MemoryArtifactStore {
  down = false;
  private check() {
    if (this.down) throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
  }
  override async put(key: string, content: Buffer): Promise<void> {
    this.check();
    return super.put(key, content);
  }
  override async get(key: string): Promise<Buffer | null> {
    this.check();
    return super.get(key);
  }
  override async delete(key: string): Promise<void> {
    this.check();
    return super.delete(key);
  }
}

const settle = async (done: () => boolean | Promise<boolean>, what = 'The condition') => {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} was never met.`);
};

describe('failure drills', () => {
  let hash: string;
  let stores: TestStore;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let port: number;
  let admin: Actor;
  let employee: Actor;
  let otherAdmin: Actor;
  let agentId: string;
  let signer: ManifestSigner;
  let secrets: MemorySecretStore;
  let vault: { down: boolean };
  let objects: SwitchableStore;
  let spans: MemorySpanExporter;
  let telemetry: Telemetry;
  /** What Jira received, and how it answers. */
  let jira: unknown[];
  let jiraAnswers: (received: number) => Promise<Response>;
  const sessions = new Map<string, string>();
  const hosts: RuntimeHost[] = [];
  const cleanup: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });

  const options = (extra: Partial<ControlPlaneDatabaseOptions> = {}) => {
    const provider: SecretProvider = {
      id: 'drill-vault',
      resolve: async (organizationId, name) => {
        if (vault.down) throw new Error('VAULT_HTTP_503');
        return new DevelopmentSecretProvider(secrets).resolve(organizationId, name);
      },
    };
    return {
      seedDemo: false,
      manifestV2Issuance: true,
      genericRuntime: true,
      signer,
      secretProvider: provider,
      artifactStore: objects,
      telemetry,
      connectorFetch: (async (_url: unknown, init?: RequestInit) => {
        jira.push(JSON.parse(String(init!.body)));
        return jiraAnswers(jira.length);
      }) as typeof fetch,
      runtimeIdentities: [
        ...(['a', 'b'] as const).map((name) => ({
          id: `runtime-${name}`,
          publicKeySpki: keys[name].spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        })),
        {
          id: 'execution-1',
          role: 'execution' as const,
          publicKeySpki: executionKey.spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
      ...extra,
    } satisfies Partial<ControlPlaneDatabaseOptions>;
  };
  const executionKey = runtimeKeyPair();

  const listen = (target: ReturnType<typeof createApp>, onPort = 0) =>
    new Promise<Server>((resolve) => {
      const listening = target.listen(onPort, '127.0.0.1', () => resolve(listening));
    });

  beforeEach(async () => {
    secrets = new MemorySecretStore();
    vault = { down: false };
    objects = new SwitchableStore();
    spans = new MemorySpanExporter();
    telemetry = new Telemetry('drill', [spans]);
    signer = new ManifestSigner();
    jira = [];
    jiraAnswers = async () => Response.json({ id: '10001', key: 'QA-42' }, { status: 201 });
    stores = await testStore();
    db = await ControlPlaneDatabase.open({ ...options(), store: stores.store });
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
    secrets.set(admin.organizationId, 'jira-token', JIRA_TOKEN);
    secrets.set(admin.organizationId, 'model-key', MODEL_KEY);
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
    await call('put', '/api/organization/model-credentials/test-provider', admin, {
      secretRef: 'secret://model-key',
    }).expect(200);
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
    server = await listen(app);
    port = (server.address() as AddressInfo).port;
    hosts.length = 0;
    cleanup.length = 0;
  });

  afterEach(async () => {
    for (const open of gates.splice(0)) open();
    await Promise.all(hosts.map((host) => host.drain()));
    for (const step of cleanup.reverse()) await step();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await stores.drop();
  });

  const raw = () => new RawSql(db.store);
  const call = (method: 'get' | 'post' | 'put', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', sessions.get(actor.id)!)
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };

  interface RuntimeParts {
    provider?: ModelProvider;
    tools?: object[];
    transport?: (client: ControlPlaneClient) => ArtifactTransport;
  }

  /** An agent runtime process: durable checkpoints and artifacts, credentials from the control plane. */
  const runtime = (name: 'a' | 'b', script: Script, parts: RuntimeParts = {}) => {
    const controlPlane = new ControlPlaneClient({
      baseUrl: `http://127.0.0.1:${port}`,
      runtimeId: `runtime-${name}`,
      privateKey: keys[name].privateKey,
      timeoutMs: 5000,
    });
    const provider = parts.provider ?? new DrillProvider(script);
    const host = new RuntimeHost({
      controlPlane,
      verifier: new ManifestVerifier(signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway([provider], {
        resolve: async () => {
          throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
        },
      }),
      modelCredentials: (correlation) =>
        new ControlPlaneModelCredentials(async (providerId) => ({
          apiKey: (
            await controlPlane.modelCredential({
              protocol: RUNTIME_PROTOCOL_V1,
              correlation,
              provider: providerId,
            })
          ).apiKey,
        })),
      tools: new ToolRegistry(
        (parts.tools as RuntimeTool[] | undefined) ?? [new ArtifactTool(), new IssueTrackerTool()],
      ),
      artifacts: new ControlPlaneArtifactStore(parts.transport?.(controlPlane) ?? controlPlane),
      checkpoints: new ControlPlaneCheckpointStore(controlPlane),
      logger: silent,
      telemetry,
      retry: { attempts: 6, baseDelayMs: 20, inProgressTimeoutMs: 20_000 },
    });
    hosts.push(host);
    return { host, provider: provider as DrillProvider };
  };

  const startRun = async () =>
    (
      await call('post', '/api/execution/v1/runs', employee, {
        agentId,
        task: { objective: 'File the checkout defect', inputs: {} },
      }).expect(202)
    ).body as { id: string; threadId: string };
  const detail = (runId: string) => db.execution.getRun(employee, runId);
  const status = async (runId: string) => (await detail(runId)).run.status;
  const approve = async (runId: string) => {
    const approval = (await detail(runId)).approvals.find((item) => item.status === 'PENDING')!;
    await call('post', `/api/approvals/${approval.id}/decision`, admin, {
      decision: 'APPROVED',
    }).expect(200);
  };
  /** The runtime holding the run stopped signalling it longer ago than a lease lasts. */
  const expireLease = (runId: string) =>
    raw()
      .prepare('UPDATE agent_run_leases SET lease_expires_at=?, heartbeat_at=? WHERE run_id=?')
      .run(
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        runId,
      );
  const steps = async (runId: string) =>
    (await detail(runId)).steps.map((step) => `${step.kind}:${step.status}`);
  const eventTypes = async (runId: string) =>
    (await db.execution.listEvents(employee, runId, 0, 500)).items.map((event) => event.type);
  const toolFailures = async (runId: string) =>
    (await db.execution.listEvents(employee, runId, 0, 500)).items
      .filter((event) => event.type === 'tool.failed')
      .map((event) => (event.payload as { error: { code: string } }).error.code);
  const executions = (runId: string) =>
    raw()
      .prepare(
        'SELECT status, error_code FROM agent_action_executions WHERE run_id=? ORDER BY started_at',
      )
      .all(runId);
  const metric = async (name: string, labels: Record<string, string> = {}) =>
    (await telemetry.metrics.collect())
      .find((family) => family.name === name)
      ?.points.filter((point) =>
        Object.entries(labels).every(([key, value]) => point.labels[key] === value),
      )
      .reduce((total, point) => total + (point.count ?? point.value), 0) ?? 0;
  /** Runs `host` until its run pauses or ends. */
  const work = async (host: RuntimeHost) => {
    expect(await host.pollOnce()).toBe(true);
    await host.drain();
  };
  /** Nothing the platform stored or exported names a secret. */
  const assertNoSecrets = async () => {
    const stored = JSON.stringify([
      await raw().prepare('SELECT * FROM agent_events').all(),
      await raw().prepare('SELECT * FROM audit_events').all(),
      await raw().prepare('SELECT * FROM agent_run_checkpoints').all(),
      await raw().prepare('SELECT * FROM agent_action_reconciliations').all(),
      spans.spans,
      await telemetry.metrics.prometheus(),
    ]);
    expect(stored).not.toContain(JIRA_TOKEN);
    expect(stored).not.toContain(MODEL_KEY);
  };

  const reportThenDefect = inOrder(
    [
      { name: 'artifact', input: report },
      { name: 'issue-tracker', input: draft },
    ],
    'Filed the defect.',
  );

  it('1. recovers when the runtime dies during a model call (recovery)', async () => {
    const run = await startRun();
    const dead = gate();
    const a = runtime('a', reportThenDefect);
    // The second model call never returns: the runtime is gone.
    a.provider.stopAt = { call: 2, until: dead.wait };
    expect(await a.host.pollOnce()).toBe(true);
    await settle(() => a.provider.calls === 2, 'The second model call');
    expect(await steps(run.id)).toEqual(['MODEL:COMPLETED', 'TOOL:COMPLETED', 'MODEL:RUNNING']);

    await expireLease(run.id);
    const b = runtime('b', reportThenDefect);
    await work(b.host);
    expect(await status(run.id)).toBe('WAITING_FOR_APPROVAL');
    // The model step runtime A left open is closed as failed; runtime B asked the model again.
    expect(await steps(run.id)).toEqual([
      'MODEL:COMPLETED',
      'TOOL:COMPLETED',
      'MODEL:FAILED',
      'MODEL:COMPLETED',
      'TOOL:WAITING_FOR_APPROVAL',
    ]);
    await approve(run.id);
    await work(b.host);
    expect(await status(run.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    // The report was written once: the finished tool call was not repeated.
    expect((await detail(run.id)).artifacts).toHaveLength(1);
    // The interrupted call stays counted at what it reserved; a lost call never frees budget.
    const reservations = await raw()
      .prepare('SELECT status FROM model_usage_reservations WHERE run_id=? ORDER BY created_at')
      .all(run.id);
    expect(reservations.map((row) => row['status'])).toEqual([
      'SETTLED',
      'RESERVED',
      'SETTLED',
      'SETTLED',
    ]);
    // Runtime A comes back: the run is no longer its to touch.
    dead.open();
    await a.host.drain();
    expect(await status(run.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    expect(await metric('af_run_recoveries_total', { command: 'run.recover' })).toBe(1);
    await assertNoSecrets();
  }, 90_000);

  it('2. recovers when the runtime dies immediately before a tool (recovery)', async () => {
    const run = await startRun();
    const dead = gate();
    const a = runtime('a', reportThenDefect, {
      tools: [new ArtifactTool(), stopping(new IssueTrackerTool(), { before: dead.wait })],
    });
    await work(a.host);
    await approve(run.id);
    // Approved and started, but the runtime stops before it asks for the action.
    expect(await a.host.pollOnce()).toBe(true);
    await settle(
      async () => (await eventTypes(run.id)).filter((t) => t === 'tool.started').length === 2,
    );
    expect(jira).toHaveLength(0);
    expect(await executions(run.id)).toEqual([]);

    await expireLease(run.id);
    const b = runtime('b', reportThenDefect);
    await work(b.host);
    expect(await status(run.id)).toBe('COMPLETED');
    // One decision, one approval, one execution, one issue.
    expect(jira).toHaveLength(1);
    expect(await executions(run.id)).toEqual([{ status: 'SUCCEEDED', error_code: null }]);
    expect(
      await raw().prepare('SELECT id FROM agent_action_requests WHERE run_id=?').all(run.id),
    ).toHaveLength(1);
    expect((await detail(run.id)).approvals).toHaveLength(1);
    dead.open();
    await a.host.drain();
    expect(jira).toHaveLength(1);
  }, 90_000);

  it('3. reuses the recorded result when the runtime dies after a governed action succeeded (idempotent reuse)', async () => {
    const run = await startRun();
    const dead = gate();
    const a = runtime('a', reportThenDefect, {
      tools: [new ArtifactTool(), stopping(new IssueTrackerTool(), { after: dead.wait })],
    });
    await work(a.host);
    await approve(run.id);
    expect(await a.host.pollOnce()).toBe(true);
    // Jira has the issue and the control plane recorded it; the runtime died holding the answer.
    await settle(
      async () => (await executions(run.id))[0]?.['status'] === 'SUCCEEDED',
      'The recorded execution',
    );
    expect(jira).toHaveLength(1);

    await expireLease(run.id);
    const b = runtime('b', reportThenDefect);
    await work(b.host);
    expect(await status(run.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    expect(await executions(run.id)).toEqual([{ status: 'SUCCEEDED', error_code: null }]);
    expect((await db.execution.listEvents(employee, run.id, 0, 500)).items.at(-1)!.payload).toEqual(
      expect.objectContaining({ summary: 'Filed the defect.' }),
    );
    dead.open();
    await a.host.drain();
    expect(jira).toHaveLength(1);
  }, 90_000);

  it('4. reuses the execution result when the runtime dies after the operation but before its checkpoint (idempotent reuse)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-drill-'));
    const state = new StateStore(':memory:');
    const recording = new RecordingProvider();
    const executionServer = createExecutionServer(
      new ExecutionService({
        verifier: new GrantVerifier(signer.verificationKey.publicKeySpki),
        provider: recording,
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        allowUnsandboxed: true,
        telemetry,
      }),
      recording,
    );
    await new Promise<void>((resolve) => executionServer.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      await new Promise((resolve) => executionServer.close(resolve));
      state.close();
      rmSync(root, { recursive: true, force: true });
    });
    const execution = new ExecutionClient(
      `http://127.0.0.1:${(executionServer.address() as AddressInfo).port}`,
    );
    const script = inOrder([{ name: 'repository', input: checkout }], 'Checked out.');
    const run = await startRun();
    const dead = gate();
    const a = runtime('a', script, {
      tools: [stopping(new RepositoryTool(execution), { after: dead.wait })],
    });
    expect(await a.host.pollOnce()).toBe(true);
    await settle(() => recording.seen.length === 1, 'The checkout');

    await expireLease(run.id);
    const b = runtime('b', script, { tools: [new RepositoryTool(execution)] });
    await work(b.host);
    expect(await status(run.id)).toBe('COMPLETED');
    // The same grant was presented again and answered from the execution runtime's record.
    expect(recording.seen).toEqual([checkout]);
    expect(
      await raw().prepare('SELECT grant_id FROM agent_execution_grants WHERE run_id=?').all(run.id),
    ).toHaveLength(1);
    expect(await metric('af_execution_grants_total', { result: 'reused' })).toBe(1);
    expect(await metric('af_execution_operations_total', { kind: 'git.checkout' })).toBe(1);
    dead.open();
    await a.host.drain();
    expect(recording.seen).toHaveLength(1);
  }, 90_000);

  it('5. recovers when the runtime dies during an artifact upload, and removes what it left (recovery)', async () => {
    const run = await startRun();
    const dead = gate();
    const script = inOrder([{ name: 'artifact', input: report }], 'Stored the plan.');
    // The bytes reach the store, then the runtime dies before registering the artifact.
    const a = runtime('a', script, {
      transport: (client) => ({
        uploadArtifact: async (upload: RuntimeArtifactUploadRequest) => {
          const stored = await client.uploadArtifact(upload);
          await dead.wait;
          return stored;
        },
      }),
    });
    expect(await a.host.pollOnce()).toBe(true);
    await settle(() => objects.objects.size === 1, 'The upload');
    expect((await detail(run.id)).artifacts).toEqual([]);

    await expireLease(run.id);
    const b = runtime('b', script);
    await work(b.host);
    expect(await status(run.id)).toBe('COMPLETED');
    // Exactly one artifact belongs to the run; the orphan is stored but registered nowhere.
    expect((await detail(run.id)).artifacts).toHaveLength(1);
    const rows = () =>
      raw().prepare('SELECT state, deletion_reason FROM agent_artifact_objects ORDER BY seq').all();
    expect(await rows()).toEqual([
      { state: 'STORED', deletion_reason: null },
      { state: 'REGISTERED', deletion_reason: null },
    ]);
    expect(objects.objects.size).toBe(2);
    // Retention removes the orphan's bytes and records it; the registered artifact stays.
    expect(await db.artifacts.enforceRetention(Date.now() + 25 * 60 * 60_000)).toBe(1);
    expect(await rows()).toEqual([
      { state: 'DELETED', deletion_reason: 'NEVER_REGISTERED' },
      { state: 'REGISTERED', deletion_reason: null },
    ]);
    expect(objects.objects.size).toBe(1);
    dead.open();
    await a.host.drain();
    expect((await detail(run.id)).artifacts).toHaveLength(1);
  }, 90_000);

  /** A new control-plane process on the same database, key and address. */
  const restartControlPlane = async (extra: Partial<ControlPlaneDatabaseOptions> = {}) => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db = await ControlPlaneDatabase.open({ ...options(extra), store: await stores.connect() });
    app = createApp(db, config);
    server = await listen(app, port);
  };

  it('6a. lets active runs continue after the control plane restarts (recovery)', async () => {
    const run = await startRun();
    const a = runtime('a', reportThenDefect);
    await work(a.host);
    expect(await status(run.id)).toBe('WAITING_FOR_APPROVAL');
    await restartControlPlane();
    // The decision is taken by the new process; the runtime carries on with the same lease.
    await approve(run.id);
    await work(a.host);
    expect(await status(run.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    expect((await detail(run.id)).artifacts).toHaveLength(1);
    expect((await eventTypes(run.id)).filter((type) => type === 'run.started')).toHaveLength(1);
  }, 90_000);

  it('6b. stops for reconciliation when the control plane dies while dispatching a write (manual reconciliation)', async () => {
    // Jira received the request and never answered this process.
    const never = gate();
    jiraAnswers = async () => {
      await never.wait;
      return Response.json({ id: '1', key: 'QA-1' }, { status: 201 });
    };
    const script: Script = (results) =>
      results.length === 0
        ? { name: 'issue-tracker', input: draft }
        : results.length === 1 && results[0]!.isError
          ? { name: 'issue-tracker', input: draft }
          : `Stopped: ${results.at(-1)!.content.split(':')[0]}`;
    const run = await startRun();
    const a = runtime('a', script);
    await work(a.host);
    await approve(run.id);
    expect(await a.host.pollOnce()).toBe(true);
    await settle(() => jira.length === 1, 'The dispatch');
    expect(await executions(run.id)).toEqual([{ status: 'DISPATCHING', error_code: null }]);

    // The control plane is replaced mid-dispatch. The runtime's request fails and is repeated.
    await restartControlPlane({ staleDispatchMs: 400 });
    await a.host.drain();
    expect(await status(run.id)).toBe('COMPLETED');
    // Never dispatched again: not by the retry, and not when the model asked a second time.
    expect(jira).toHaveLength(1);
    expect(await executions(run.id)).toEqual([
      { status: 'FAILED', error_code: 'DISPATCH_INTERRUPTED' },
    ]);
    expect(await toolFailures(run.id)).toEqual(['DISPATCH_INTERRUPTED', 'ACTION_DENIED']);
    expect(
      await raw()
        .prepare("SELECT reason FROM agent_action_requests WHERE run_id=? AND decision='DENIED'")
        .all(run.id),
    ).toEqual([{ reason: 'ACTION_RECONCILIATION_REQUIRED' }]);
    const open = (await call('get', '/api/organization/action-reconciliations', admin).expect(200))
      .body;
    expect(open).toEqual([
      expect.objectContaining({
        runId: run.id,
        action: 'jira.issue.create',
        reason: 'DISPATCH_INTERRUPTED',
        state: 'REQUIRED',
      }),
    ]);
    never.open();
  }, 90_000);

  it('6c. closes dispatches a stopped control plane left open, without its runtime asking', async () => {
    const never = gate();
    jiraAnswers = async () => {
      await never.wait;
      return new Response(null, { status: 500 });
    };
    const run = await startRun();
    const a = runtime('a', inOrder([{ name: 'issue-tracker', input: draft }], 'Stopped.'));
    await work(a.host);
    await approve(run.id);
    expect(await a.host.pollOnce()).toBe(true);
    await settle(() => jira.length === 1, 'The dispatch');
    expect(await db.actions.reconcileInterrupted()).toBe(0);
    // Longer ago than any dispatch can take: it was interrupted.
    expect(await db.actions.reconcileInterrupted(Date.now() + 10 * 60_000)).toBe(1);
    expect(await executions(run.id)).toEqual([
      { status: 'FAILED', error_code: 'DISPATCH_INTERRUPTED' },
    ]);
    expect(await db.actions.reconcileInterrupted(Date.now() + 10 * 60_000)).toBe(0);
    // The late answer changes nothing that was recorded.
    never.open();
    await a.host.drain();
    expect(await executions(run.id)).toEqual([
      { status: 'FAILED', error_code: 'DISPATCH_INTERRUPTED' },
    ]);
    expect(jira).toHaveLength(1);
  }, 90_000);

  it('8. fails closed when the secret store is unavailable (fail closed, then safe retry)', async () => {
    // No model key: the run fails before any model call is made.
    vault.down = true;
    const first = await startRun();
    const a = runtime('a', reportThenDefect);
    await work(a.host);
    expect((await detail(first.id)).run).toMatchObject({
      status: 'FAILED',
      statusReason: 'MODEL_CREDENTIAL_UNAVAILABLE',
    });
    expect(a.provider.calls).toBe(0);
    expect(await metric('af_secret_resolutions_total', { result: 'provider_unavailable' })).toBe(1);

    // The store is back for the model, and gone again when the connector needs its token.
    vault.down = false;
    const second = await startRun();
    const script: Script = (results) =>
      results.length === 0
        ? { name: 'issue-tracker', input: draft }
        : `Stopped: ${results.at(-1)!.content.split(':')[0]}`;
    const b = runtime('b', script);
    await work(b.host);
    await approve(second.id);
    vault.down = true;
    // The approved action is refused for want of its token, and the run then fails closed for
    // want of the model key. Jira is never called.
    await work(b.host);
    expect((await detail(second.id)).run).toMatchObject({
      status: 'FAILED',
      statusReason: 'MODEL_CREDENTIAL_UNAVAILABLE',
    });
    expect(jira).toHaveLength(0);
    expect(await executions(second.id)).toEqual([
      { status: 'FAILED', error_code: 'SECRET_UNRESOLVED' },
    ]);
    // A refusal is final for that request; nothing is waiting to reconcile.
    expect(
      (await call('get', '/api/organization/action-reconciliations', admin).expect(200)).body,
    ).toEqual([]);

    // With the store back, a new run files the defect once.
    vault.down = false;
    const third = await startRun();
    const c = runtime('a', reportThenDefect);
    await work(c.host);
    await approve(third.id);
    await work(c.host);
    expect(await status(third.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(1);
    expect(c.provider.keys.every((key) => key === MODEL_KEY)).toBe(true);
    await assertNoSecrets();
  }, 120_000);

  it('9. keeps the run going when the artifact store is unavailable, and stores again when it returns (safe retry)', async () => {
    objects.down = true;
    const run = await startRun();
    const script: Script = (results) =>
      results.length < 2 ? { name: 'artifact', input: report } : 'Stored the plan.';
    const a = runtime('a', script);
    expect(await a.host.pollOnce()).toBe(true);
    // The first attempt fails as a tool error the model can see; nothing is registered.
    await settle(async () => (await toolFailures(run.id)).length === 1, 'The failed upload');
    expect((await detail(run.id)).artifacts).toEqual([]);
    expect(await metric('af_object_store_failures_total', { operation: 'put' })).toBe(1);
    objects.down = false;
    await a.host.drain();
    expect(await status(run.id)).toBe('COMPLETED');
    const [artifact] = (await detail(run.id)).artifacts;
    expect(artifact).toMatchObject({ name: 'plan.md', content: { state: 'AVAILABLE' } });
    // The failed attempt left a reservation with no bytes; retention clears it.
    expect(
      await raw().prepare('SELECT state FROM agent_artifact_objects ORDER BY seq').all(),
    ).toEqual([{ state: 'PENDING' }, { state: 'REGISTERED' }]);

    // Retrieval while the store is down is refused, not served stale or partial.
    const permission = (
      await call('post', `/api/execution/v1/artifacts/${artifact!.id}/retrievals`, employee).expect(
        201,
      )
    ).body as { path: string };
    objects.down = true;
    await call('get', permission.path, employee).expect(503, {
      error: 'ARTIFACT_STORE_UNAVAILABLE',
    });
    objects.down = false;
    const again = (
      await call('post', `/api/execution/v1/artifacts/${artifact!.id}/retrievals`, employee).expect(
        201,
      )
    ).body as { path: string };
    expect((await call('get', again.path, employee).expect(200)).text ?? '').toBeDefined();
    expect(await metric('af_artifact_retrievals_total', { result: 'retrieved' })).toBe(1);
  }, 90_000);

  it('10. rides out lost database connections (safe retry)', async () => {
    const adminClient = new pg.Client({ connectionString: inject('postgresAdminUrl') });
    await adminClient.connect();
    cleanup.push(() => adminClient.end());
    const database = (await db.store.platform(() =>
      db.store.get<{ name: string }>('SELECT current_database() AS name'),
    ))!.name;
    const terminate = () =>
      adminClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );

    // A transaction whose connection dies mid-way is run again and commits once.
    let attempts = 0;
    const result = await db.store.platform(async () => {
      attempts += 1;
      await db.store.run(
        `INSERT INTO runtime_request_nonces (runtime_id, nonce, expires_at) VALUES ('drill','n-1',?)`,
        Date.now() + 60_000,
      );
      if (attempts === 1) await terminate();
      return (await db.store.get<{ count: number }>(
        `SELECT count(*)::int AS count FROM runtime_request_nonces WHERE runtime_id='drill'`,
      ))!.count;
    });
    expect(attempts).toBe(2);
    expect(result).toBe(1);
    expect(await metric('af_database_retries_total', { reason: 'connection' })).toBeGreaterThan(0);

    // A whole run while connections keep being cut underneath it.
    const run = await startRun();
    const a = runtime('a', reportThenDefect);
    let cutting = true;
    const cutter = (async () => {
      while (cutting) {
        await terminate().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();
    try {
      await settle(async () => {
        if ((await status(run.id).catch(() => 'UNKNOWN')) !== 'QUEUED') return true;
        await a.host.pollOnce().catch(() => false);
        return false;
      }, 'The claim');
      await a.host.drain();
    } finally {
      cutting = false;
      await cutter;
    }
    // Whether the cuts landed on a retried request or failed the run, nothing was duplicated
    // and the history is whole.
    const outcome = await status(run.id);
    expect(['WAITING_FOR_APPROVAL', 'FAILED']).toContain(outcome);
    const events = (await db.execution.listEvents(employee, run.id, 0, 500)).items;
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect((await detail(run.id)).artifacts.length).toBeLessThanOrEqual(1);
    expect(jira).toHaveLength(0);
    if (outcome === 'WAITING_FOR_APPROVAL') {
      await approve(run.id);
      await work(a.host);
      expect(await status(run.id)).toBe('COMPLETED');
      expect(jira).toHaveLength(1);
    }
  }, 120_000);

  it('12. stops for reconciliation when a connector times out after the remote system may have accepted (manual reconciliation)', async () => {
    // Jira takes the request, then the connection drops before any answer.
    jiraAnswers = async () => {
      throw new TypeError('fetch failed');
    };
    const altered = { ...draft, summary: 'Cart total ignores the discount (retry)' };
    const script: Script = (results) =>
      results.length === 0
        ? { name: 'issue-tracker', input: draft }
        : results.length === 1
          ? { name: 'issue-tracker', input: draft }
          : results.length === 2
            ? { name: 'issue-tracker', input: altered }
            : 'I could not confirm the defect was filed.';
    const run = await startRun();
    const a = runtime('a', script);
    await work(a.host);
    await approve(run.id);
    await work(a.host);
    expect(await status(run.id)).toBe('COMPLETED');
    // One request reached Jira. The same payload, and a reworded one, were both refused.
    expect(jira).toHaveLength(1);
    expect(await executions(run.id)).toEqual([
      { status: 'FAILED', error_code: 'CONNECTOR_OUTCOME_UNKNOWN' },
    ]);
    expect(await toolFailures(run.id)).toEqual([
      'CONNECTOR_OUTCOME_UNKNOWN',
      'ACTION_DENIED',
      'ACTION_DENIED',
    ]);
    const [reconciliation] = (
      await call('get', '/api/organization/action-reconciliations', admin).expect(200)
    ).body;
    expect(reconciliation).toMatchObject({
      runId: run.id,
      reason: 'CONNECTOR_OUTCOME_UNKNOWN',
      state: 'REQUIRED',
    });
    expect(await metric('af_action_reconciliations_total', { event: 'required' })).toBe(1);

    // The same defect from a new run and a new thread is refused too, while it is open.
    jiraAnswers = async () => Response.json({ id: '10002', key: 'QA-43' }, { status: 201 });
    const second = await startRun();
    const b = runtime('b', inOrder([{ name: 'issue-tracker', input: draft }], 'Refused.'));
    await work(b.host);
    expect(await status(second.id)).toBe('COMPLETED');
    expect(await toolFailures(second.id)).toEqual(['ACTION_DENIED']);
    expect(jira).toHaveLength(1);

    // Only an administrator of that organization can resolve it, once.
    const path = `/api/organization/action-reconciliations/${reconciliation.requestId}/resolution`;
    await call('post', path, employee, { resolution: 'NOT_APPLIED' }).expect(403);
    await call('post', path, otherAdmin, { resolution: 'NOT_APPLIED' }).expect(404, {
      error: 'RECONCILIATION_NOT_FOUND',
    });
    expect(
      (await call('get', '/api/organization/action-reconciliations', otherAdmin).expect(200)).body,
    ).toEqual([]);
    await call('post', path, admin, { resolution: 'MAYBE' }).expect(400);
    expect(
      (
        await call('post', path, admin, {
          resolution: 'NOT_APPLIED',
          note: 'Checked the QA project: no such issue.',
        }).expect(200)
      ).body,
    ).toMatchObject({ state: 'NOT_APPLIED', resolvedBy: admin.id });
    await call('post', path, admin, { resolution: 'APPLIED' }).expect(409, {
      error: 'RECONCILIATION_RESOLVED',
    });
    await expect(
      raw()
        .prepare("UPDATE agent_action_reconciliations SET state='REQUIRED' WHERE request_id=?")
        .run(reconciliation.requestId),
    ).rejects.toThrow(/ACTION_RECONCILIATION_FINAL/);
    await expect(raw().prepare('DELETE FROM agent_action_reconciliations').run()).rejects.toThrow(
      /ACTION_RECONCILIATION_RETAINED/,
    );

    // Jira does not have it, so now the defect may be filed: exactly once more.
    const third = await startRun();
    const c = runtime('a', inOrder([{ name: 'issue-tracker', input: draft }], 'Filed.'));
    await work(c.host);
    await approve(third.id);
    await work(c.host);
    expect(await status(third.id)).toBe('COMPLETED');
    expect(jira).toHaveLength(2);
    expect(await executions(third.id)).toEqual([{ status: 'SUCCEEDED', error_code: null }]);
    await assertNoSecrets();
  }, 120_000);

  it('12b. treats a server error and an unreadable answer to a write as unknown, and a refusal as final', async () => {
    const outcomes: Record<string, string> = {};
    for (const [label, answer] of [
      ['server-error', async () => new Response('upstream timeout', { status: 504 })],
      ['unreadable', async () => new Response('<html>', { status: 201 })],
      ['refused', async () => Response.json({ errors: {} }, { status: 400 })],
    ] as const) {
      jiraAnswers = answer;
      const input = { ...draft, summary: `Defect ${label}` };
      const run = await startRun();
      const a = runtime('a', inOrder([{ name: 'issue-tracker', input }], 'Stopped.'));
      await work(a.host);
      await approve(run.id);
      await work(a.host);
      outcomes[label] = String((await executions(run.id))[0]!['error_code']);
      // Each thread's own open reconciliation would block the next: resolve as it would be.
      for (const item of (
        await call('get', '/api/organization/action-reconciliations', admin).expect(200)
      ).body as { requestId: string; state: string }[])
        if (item.state === 'REQUIRED')
          await call(
            'post',
            `/api/organization/action-reconciliations/${item.requestId}/resolution`,
            admin,
            { resolution: 'APPLIED' },
          ).expect(200);
    }
    expect(outcomes).toEqual({
      'server-error': 'CONNECTOR_OUTCOME_UNKNOWN',
      unreadable: 'CONNECTOR_OUTCOME_UNKNOWN',
      refused: 'CONNECTOR_REQUEST_FAILED',
    });
    expect(
      await raw()
        .prepare('SELECT reason, state FROM agent_action_reconciliations ORDER BY seq')
        .all(),
    ).toEqual([
      { reason: 'CONNECTOR_OUTCOME_UNKNOWN', state: 'APPLIED' },
      { reason: 'CONNECTOR_OUTCOME_UNKNOWN', state: 'APPLIED' },
    ]);
    // Reconciliations are tenant rows under forced row-level security.
    expect(
      await db.store.tenant(otherAdmin.organizationId, () =>
        db.store.all('SELECT request_id FROM agent_action_reconciliations'),
      ),
    ).toEqual([]);
  }, 120_000);
  it('12c. shows administrators the unknown write without its payload, and blocks it until they resolve it', async () => {
    jiraAnswers = async () => {
      throw new TypeError('fetch failed');
    };
    const leaked = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const input = { ...draft, summary: `Login rejects token=${leaked}` };
    const first = await startRun();
    const a = runtime('a', inOrder([{ name: 'issue-tracker', input }], 'Unconfirmed.'));
    await work(a.host);
    await approve(first.id);
    await work(a.host);
    expect(jira).toHaveLength(1);

    const listing = await call('get', '/api/organization/action-reconciliations', admin).expect(
      200,
    );
    const [item] = listing.body;
    expect(item).toMatchObject({
      runId: first.id,
      threadId: first.threadId,
      action: 'jira.issue.create',
      target: { type: 'issue-tracker.project', id: 'QA' },
      reason: 'CONNECTOR_OUTCOME_UNKNOWN',
      state: 'REQUIRED',
    });
    expect(item.stepId).toEqual(expect.any(String));
    expect(item.summary).toBe('Create Jira bug in QA: Login rejects [redacted]');
    // The request is described, never carried: no description, digest, payload or credential.
    const shown = JSON.stringify(listing.body);
    for (const absent of [leaked, draft.description, 'Steps:', JIRA_TOKEN, 'secret://'])
      expect(shown).not.toContain(absent);
    expect(Object.keys(item)).not.toEqual(
      expect.arrayContaining(['parameters', 'payloadDigest', 'payload_digest']),
    );
    await call('get', '/api/organization/action-reconciliations', employee).expect(403);
    expect(await metric('af_action_reconciliations_open')).toBe(1);

    // Unresolved, the same write is refused from another run and thread, every time.
    jiraAnswers = async () => Response.json({ id: '10003', key: 'QA-44' }, { status: 201 });
    for (const name of ['b', 'a'] as const) {
      const blocked = await startRun();
      const host = runtime(name, inOrder([{ name: 'issue-tracker', input }], 'Refused.')).host;
      await work(host);
      expect(await toolFailures(blocked.id)).toEqual(['ACTION_DENIED']);
      expect((await detail(blocked.id)).approvals).toEqual([]);
    }
    expect(jira).toHaveLength(1);

    // Resolved as applied, once, and only then may the action be decided again.
    const path = `/api/organization/action-reconciliations/${item.requestId}/resolution`;
    expect(
      (await call('post', path, admin, { resolution: 'APPLIED', note: 'QA-43 exists' }).expect(200))
        .body,
    ).toMatchObject({ state: 'APPLIED', resolvedBy: admin.id, note: 'QA-43 exists' });
    await call('post', path, admin, { resolution: 'NOT_APPLIED' }).expect(409);
    expect(await metric('af_action_reconciliations_open')).toBe(0);
    const after = await startRun();
    const c = runtime('b', inOrder([{ name: 'issue-tracker', input }], 'Filed.'));
    await work(c.host);
    expect((await detail(after.id)).approvals.map((approval) => approval.status)).toEqual([
      'PENDING',
    ]);
    await assertNoSecrets();
  }, 120_000);
});
