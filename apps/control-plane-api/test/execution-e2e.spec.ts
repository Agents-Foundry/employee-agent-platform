import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionOperation, ResourceLimits } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway, type ModelResponse } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import { BrowserTool, RepositoryTool } from '../../agent-runtime/src/tools/execution-tools.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { ExecutionService } from '../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../execution-runtime/src/artifact-store.js';
import { StateStore } from '../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../execution-runtime/src/server.js';
import type {
  ExecutionProvider,
  ProviderOutcome,
} from '../../execution-runtime/src/providers/execution-provider.js';

const org = 'org_agents_foundry';
const employee = { id: 'employee_qa_demo', role: 'EMPLOYEE' as const, organizationId: org };
const adminHeaders = {
  'x-actor-id': 'admin_demo',
  'x-actor-role': 'ADMIN',
  'x-organization-id': org,
};
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Stand-in provider: records what the execution runtime was authorized to run. Real git and
 * Playwright execution is covered by the execution-runtime package's own tests.
 */
class RecordingProvider implements ExecutionProvider {
  readonly id = 'recording';
  readonly isolation = 'local' as const;
  readonly enforces = ['timeout'] as const;
  readonly seen: { operation: ExecutionOperation; limits: ResourceLimits }[] = [];
  async execute(
    _workspace: unknown,
    operation: ExecutionOperation,
    limits: ResourceLimits,
  ): Promise<ProviderOutcome> {
    this.seen.push({ operation, limits });
    if (operation.kind === 'playwright.run')
      return {
        status: 'SUCCEEDED',
        output: 'Playwright project smoke: 3 passed, 0 failed.',
        truncated: false,
        artifacts: [
          {
            name: 'playwright-report.json',
            type: 'test_report',
            mediaType: 'application/json',
            content: Buffer.from('{"stats":{"expected":3}}'),
          },
        ],
      };
    return {
      status: 'SUCCEEDED',
      output: `Checked out into ${'path' in operation ? operation.path : ''}.`,
      truncated: false,
      artifacts: [],
    };
  }
}

const checkout = (repositoryUrl: string) => ({
  kind: 'git.checkout',
  repositoryUrl,
  ref: 'main',
  path: 'repo',
});
const playwright = {
  kind: 'playwright.run',
  project: 'smoke',
  baseUrl: 'https://qa.example.com/cart',
  path: 'repo',
};

/** Check out the configured repo, try a foreign one, then run Playwright, then finish. */
const script = (req: { messages: { content: { type: string }[] }[] }): ModelResponse => {
  const results = req.messages.flatMap((m) =>
    m.content.filter((b) => b.type === 'tool_result'),
  ).length;
  const usage = { inputTokens: 1, outputTokens: 1 };
  const call = (name: string, input: object): ModelResponse => ({
    content: [{ type: 'tool_use', id: `toolu_${results}`, name, input }],
    stopReason: 'tool_use',
    usage,
  });
  if (results === 0) return call('repository', checkout('https://example.com/repo.git'));
  if (results === 1) return call('repository', checkout('https://evil.example.com/repo'));
  if (results === 2) return call('browser', playwright);
  return {
    content: [{ type: 'text', text: 'Smoke tests passed.' }],
    stopReason: 'end_turn',
    usage,
  };
};

describe('execution runtime end to end under control-plane grants', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let controlServer: Server;
  let executionServer: Server;
  let state: StateStore;
  let provider: RecordingProvider;
  let host: RuntimeHost;
  let root: string;
  let agentId: string;

  const listen = (server: Server) =>
    new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );

  beforeEach(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    db = new ControlPlaneDatabase(':memory:', true, {
      manifestV2Issuance: true,
      genericRuntime: true,
      runtimeIdentities: [
        {
          id: 'runtime-exec',
          publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = db.requestProvisioning(
      employee.id,
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
    controlServer = createServer(app);
    root = mkdtempSync(join(tmpdir(), 'af-exec-e2e-'));
    state = new StateStore(':memory:');
    provider = new RecordingProvider();
    executionServer = createExecutionServer(
      new ExecutionService({
        verifier: new GrantVerifier(db.signer.verificationKey.publicKeySpki),
        provider,
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        // The QA manifest requires a sandbox; this test accepts the local provider explicitly.
        allowUnsandboxed: true,
      }),
      provider,
    );
    const [controlUrl, executionUrl] = await Promise.all([
      listen(controlServer),
      listen(executionServer),
    ]);
    const execution = new ExecutionClient(executionUrl);
    host = new RuntimeHost({
      controlPlane: new ControlPlaneClient({
        baseUrl: controlUrl,
        runtimeId: 'runtime-exec',
        privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway([new ScriptedProvider('test-provider', script)], {
        resolve: async () => ({ apiKey: 'test-only' }),
      }),
      tools: new ToolRegistry([new RepositoryTool(execution), new BrowserTool(execution)]),
      artifacts: new MemoryArtifactStore(),
      checkpoints: new MemoryCheckpointStore(),
      logger: silent,
    });
  });

  afterEach(async () => {
    await host.drain();
    await Promise.all([
      new Promise((resolve) => controlServer.close(resolve)),
      new Promise((resolve) => executionServer.close(resolve)),
    ]);
    state.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('executes only granted, in-scope operations and pauses Playwright for approval', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'Smoke test STORY-12', inputs: {} } })
        .expect(202)
    ).body;
    await host.pollOnce();
    await host.drain();

    // Checkout of the configured repository ran; the foreign repository never reached it.
    expect(provider.seen.map((entry) => entry.operation)).toEqual([
      checkout('https://example.com/repo.git'),
    ]);
    expect(provider.seen[0]!.limits).toMatchObject({
      timeoutMs: 120_000,
      network: { mode: 'ALLOW_LIST', allowedHosts: ['example.com'] },
    });
    let detail = db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('WAITING_FOR_APPROVAL');
    const approval = detail.approvals.find((item) => item.status === 'PENDING')!;
    expect(approval.action).toBe('qa.execute_playwright');
    const listed = (await request(app).get('/api/approvals').set(adminHeaders).expect(200)).body;
    expect(listed.find((item: { id: string }) => item.id === approval.id)).toMatchObject({
      summary: 'Run Playwright project smoke against https://qa.example.com',
      resourceType: 'environment',
      resourceId: 'https://qa.example.com',
    });

    await request(app)
      .post(`/api/approvals/${approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    await host.pollOnce();
    await host.drain();

    detail = db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('COMPLETED');
    expect(provider.seen.map((entry) => entry.operation.kind)).toEqual([
      'git.checkout',
      'playwright.run',
    ]);
    expect(detail.artifacts).toEqual([
      expect.objectContaining({ type: 'test_report', name: 'playwright-report.json' }),
    ]);
    const failures = db.execution
      .listEvents(employee, run.id, 0, 200)
      .items.filter((event) => event.type === 'tool.failed')
      .map((event) => (event.payload as { error: { code: string } }).error.code);
    expect(failures).toEqual(['ACTION_DENIED']);
    const sql = (db as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    expect(
      sql.prepare('SELECT operation_kind FROM agent_execution_grants ORDER BY issued_at').all(),
    ).toEqual([{ operation_kind: 'git.checkout' }, { operation_kind: 'playwright.run' }]);
    const denied = sql
      .prepare("SELECT reason FROM agent_action_requests WHERE decision='DENIED'")
      .all();
    expect(denied).toEqual([{ reason: 'The target resource is outside the configured scope.' }]);
  });
});
