import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ExecutionOperation,
  ResourceLimits,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import {
  ModelGateway,
  type ModelRequest,
  type ModelResponse,
} from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import {
  BrowserTool,
  BuildTool,
  CodeEditorTool,
  RepositoryTool,
} from '../../agent-runtime/src/tools/execution-tools.js';
import { IssueTrackerTool } from '../../agent-runtime/src/tools/issue-tracker-tool.js';
import { SourceControlTool } from '../../agent-runtime/src/tools/source-control-tool.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { ExecutionService } from '../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../execution-runtime/src/artifact-store.js';
import { StateStore } from '../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../execution-runtime/src/server.js';
import { ContainerExecutionProvider } from '../../execution-runtime/src/providers/container-provider.js';
import { LocalExecutionProvider } from '../../execution-runtime/src/providers/local-provider.js';
import type {
  ExecutionProvider,
  ProviderOutcome,
  WorkspaceHandle,
} from '../../execution-runtime/src/providers/execution-provider.js';

const org = 'org_agents_foundry';
const employee = { id: 'employee_qa_demo', role: 'EMPLOYEE' as const, organizationId: org };
const admin = { id: 'admin_demo', role: 'ADMIN' as const, organizationId: org };
const adminHeaders = { 'x-actor-id': admin.id, 'x-actor-role': 'ADMIN', 'x-organization-id': org };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const IMAGE = 'node:22-bookworm-slim';
const BANNER = "module.exports = () => 'Free shipping over $50';\n";
const docker = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The repository "clone" is a fixture (tests cannot reach GitHub); every other operation runs
 * for real: file writes on the host, and `npm run` in a container when Docker is available.
 * Without Docker, commands are recorded instead, and the local provider stands in.
 */
class FixtureRepositoryProvider implements ExecutionProvider {
  readonly id: string;
  readonly isolation: 'sandboxed' | 'local';
  readonly enforces;
  readonly seen: { operation: ExecutionOperation; limits: ResourceLimits }[] = [];
  private readonly inner: ExecutionProvider;

  constructor(useDocker: boolean) {
    this.inner = useDocker
      ? new ContainerExecutionProvider({ image: IMAGE })
      : new LocalExecutionProvider();
    this.id = `fixture+${this.inner.id}`;
    this.isolation = this.inner.isolation;
    this.enforces = this.inner.enforces;
  }

  async execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    this.seen.push({ operation, limits });
    const done = (output: string): ProviderOutcome => ({
      status: 'SUCCEEDED',
      output,
      truncated: false,
      artifacts: [],
    });
    if (operation.kind === 'git.checkout') {
      const target = join(workspace.root, operation.path);
      mkdirSync(join(target, 'src'), { recursive: true });
      writeFileSync(
        join(target, 'package.json'),
        JSON.stringify({
          name: 'storefront',
          scripts: {
            test: "node -e \"const b=require('./src/banner.js'); if(!b().includes('Free')) process.exit(1); console.log('1 passing')\"",
          },
        }),
      );
      return done(`Checked out ${operation.ref} into ${operation.path}.`);
    }
    if (operation.kind === 'command' && this.inner.isolation === 'local')
      return done(`[recorded, not executed] ${operation.command} ${operation.args.join(' ')}`);
    return this.inner.execute(workspace, operation, limits, signal);
  }
}

const toolResults = (req: ModelRequest) =>
  req.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
  );

/** implement-ui-change: scope, check out, edit, verify, try an unlisted script, propose, report. */
function implementScript(seen: ModelRequest[], override: () => [string, object][] | null) {
  return (req: ModelRequest): ModelResponse => {
    seen.push(req);
    const results = toolResults(req).length;
    const usage = { inputTokens: 1, outputTokens: 1 };
    const call = (name: string, input: object): ModelResponse => ({
      content: [{ type: 'tool_use', id: `toolu_${results}`, name, input }],
      stopReason: 'tool_use',
      usage,
    });
    const steps: [string, object][] = override() ?? [
      ['issue-tracker', { issueKey: 'UI-7' }],
      [
        'repository',
        {
          kind: 'git.checkout',
          repositoryUrl: 'https://github.com/acme/storefront',
          ref: 'main',
          path: 'repo',
        },
      ],
      ['code-editor', { kind: 'file.write', path: 'repo/src/banner.js', content: BANNER }],
      ['build', { kind: 'command', command: 'npm', args: ['run', 'test'], cwd: 'repo' }],
      ['build', { kind: 'command', command: 'npm', args: ['run', 'deploy'], cwd: 'repo' }],
      ['browser', { kind: 'playwright.run', project: 'x', baseUrl: 'https://qa.example.com' }],
      [
        'source-control',
        {
          repository: 'acme/storefront',
          baseBranch: 'main',
          headBranch: 'agents-foundry/ui-7',
          title: 'Show the free-shipping banner',
          body: 'Implements UI-7. Verified with npm run test.',
          path: 'repo',
        },
      ],
    ];
    const next = steps[results];
    if (next) return call(next[0], next[1]);
    return {
      content: [{ type: 'text', text: 'UI-7 implemented and proposed as a draft pull request.' }],
      stopReason: 'end_turn',
      usage,
    };
  };
}

describe.each([
  ...(docker ? [{ mode: 'container sandbox', useDocker: true }] : []),
  { mode: 'recorded commands', useDocker: false },
])('Frontend Engineer on the shared runtime ($mode)', ({ useDocker }) => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let controlServer: Server;
  let executionServer: Server;
  let state: StateStore;
  let provider: FixtureRepositoryProvider;
  let host: RuntimeHost;
  let root: string;
  let agentId: string;
  let github: { method: string; path: string; body: Record<string, unknown> | null }[];
  let modelRequests: ModelRequest[];
  let scenario: [string, object][] | null;

  const listen = (server: Server) =>
    new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );
  const sql = () => (db as unknown as { db: DatabaseSync }).db;
  const BASE = 'a'.repeat(40);

  beforeEach(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secrets = new MemorySecretStore();
    secrets.set(org, 'jira-token', 'jira-test-token');
    secrets.set(org, 'github-token', 'github-test-token');
    github = [];
    modelRequests = [];
    scenario = null;
    db = new ControlPlaneDatabase(':memory:', true, {
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      connectorFetch: async (url, init) => {
        const target = new URL(String(url));
        if (target.hostname === 'demo.atlassian.net')
          return Response.json({
            key: 'UI-7',
            fields: {
              summary: 'Show a free-shipping banner',
              status: { name: 'Ready' },
              issuetype: { name: 'Story' },
              description: 'Banner text: Free shipping over $50',
            },
          });
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        github.push({ method: String(init?.method), path: target.pathname, body });
        const path = target.pathname.replace('/repos/acme/storefront', '');
        if (path === '/git/ref/heads/main') return Response.json({ object: { sha: BASE } });
        if (path === `/git/commits/${BASE}`)
          return Response.json({ tree: { sha: 'b'.repeat(40) } });
        if (path === '/git/trees') return Response.json({ sha: 'c'.repeat(40) }, { status: 201 });
        if (path === '/git/commits') return Response.json({ sha: 'd'.repeat(40) }, { status: 201 });
        if (path === '/git/refs') return Response.json({ ref: 'x' }, { status: 201 });
        if (path === '/pulls')
          return Response.json(
            { number: 42, html_url: 'https://github.com/acme/storefront/pull/42' },
            { status: 201 },
          );
        return new Response('{}', { status: 404 });
      },
      runtimeIdentities: [
        {
          id: 'runtime-fe',
          publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = db.requestProvisioning(
      employee.id,
      {
        blueprintId: 'engineering.frontend-engineer',
        blueprintVersion: '1.0.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: 'https://github.com/acme/storefront',
          projectScripts: 'lint, test',
          issueTracker: ['Jira'],
          sourceControl: ['GitHub'],
        },
      },
      org,
    );
    agentId = manifestSubject(
      db.decideProvisioning(pending.id, org, admin.id, 'APPROVED', 'Pilot').manifest!.payload,
    ).agentId;
    // The seeded demo admin has no organization membership; skip that check for the fixture.
    const authorize = db.structure.authorize;
    db.structure.authorize = () => undefined;
    db.connectors.create(admin, {
      provider: 'jira',
      name: 'Demo Jira',
      baseUrl: 'https://demo.atlassian.net',
      secretRef: 'secret://jira-token',
      settings: { allowedProjects: ['UI'] },
    });
    db.connectors.create(admin, {
      provider: 'github',
      name: 'Acme GitHub',
      baseUrl: 'https://api.github.com',
      secretRef: 'secret://github-token',
      settings: { allowedRepositories: ['acme/storefront'] },
    });
    db.structure.authorize = authorize;
    app = createApp(db);
    controlServer = createServer(app);
    root = mkdtempSync(join(tmpdir(), 'af-fe-e2e-'));
    state = new StateStore(':memory:');
    provider = new FixtureRepositoryProvider(useDocker);
    executionServer = createExecutionServer(
      new ExecutionService({
        verifier: new GrantVerifier(db.signer.verificationKey.publicKeySpki),
        provider,
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        // Only the no-Docker variant needs the development override; the sandbox satisfies it.
        allowUnsandboxed: !useDocker,
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
        runtimeId: 'runtime-fe',
        privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway(
        [
          new ScriptedProvider(
            'test-provider',
            implementScript(modelRequests, () => scenario),
          ),
        ],
        { resolve: async () => ({ apiKey: 'test-only' }) },
      ),
      // The same tool set any role's runtime carries; the manifest decides what is offered.
      tools: new ToolRegistry([
        new IssueTrackerTool(),
        new SourceControlTool(),
        new RepositoryTool(execution),
        new BrowserTool(execution),
        new CodeEditorTool(execution),
        new BuildTool(execution),
      ]),
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

  it('implements, verifies and proposes a change, publishing exactly the approved files', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({
          agentId,
          task: {
            objective: 'Implement UI-7',
            workflow: 'implement-ui-change',
            workItem: { system: 'issue-tracker', key: 'UI-7' },
            inputs: {},
          },
        })
        .expect(202)
    ).body as { id: string };
    await host.pollOnce();
    await host.drain();

    // The pinned workflow reached the kernel; the browser tool is not granted to this role.
    expect(modelRequests[0]!.system).toContain('Follow workflow implement-ui-change@1.0.0');
    const offered = modelRequests[0]!.tools.map((tool) => tool.name).sort();
    expect(offered).toEqual([
      'build',
      'code-editor',
      'issue-tracker',
      'repository',
      'source-control',
    ]);

    let detail = db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('WAITING_FOR_APPROVAL');
    const approval = detail.approvals.find((item) => item.status === 'PENDING')!;
    expect(approval).toMatchObject({ action: 'repository.pull_request.create', risk: 'HIGH' });
    const listed = (await request(app).get('/api/approvals').set(adminHeaders).expect(200)).body;
    const summary = listed.find((item: { id: string }) => item.id === approval.id)
      .summary as string;
    expect(summary).toMatch(
      /^Open a draft pull request in acme\/storefront from agents-foundry\/ui-7 into main: "Show the free-shipping banner"\. 1 file\(s\): src\/banner\.js\. Change set [0-9a-f]{12}\.$/,
    );

    // What ran, under which grant limits: no step needed network except the checkout.
    const kinds = provider.seen.map((entry) => entry.operation.kind);
    expect(kinds).toEqual(['git.checkout', 'file.write', 'command']);
    const network = provider.seen.map((entry) => entry.limits.network);
    expect(network).toEqual([
      { mode: 'ALLOW_LIST', allowedHosts: ['github.com'] },
      { mode: 'NONE', allowedHosts: [] },
      { mode: 'NONE', allowedHosts: [] },
    ]);
    const results = toolResults(modelRequests.at(-1)!).map((block) => block.content);
    expect(results[3]).toContain(useDocker ? '1 passing' : '[recorded, not executed]');
    expect(results[4]).toBe('ACTION_DENIED: The target resource is outside the configured scope.');
    expect(results[5]).toMatch(/^TOOL_NOT_AVAILABLE|Tool browser is not available/);
    const workspace = readdirSync(join(root, 'workspaces'))[0]!;
    expect(
      readFileSync(join(root, 'workspaces', workspace, 'repo', 'src', 'banner.js'), 'utf8'),
    ).toBe(BANNER);

    await request(app)
      .post(`/api/approvals/${approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    await host.pollOnce();
    await host.drain();

    detail = db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('COMPLETED');
    expect(github.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/acme/storefront/git/ref/heads/main',
      `GET /repos/acme/storefront/git/commits/${BASE}`,
      'POST /repos/acme/storefront/git/trees',
      'POST /repos/acme/storefront/git/commits',
      'POST /repos/acme/storefront/git/refs',
      'POST /repos/acme/storefront/pulls',
    ]);
    expect(github[2]!.body).toEqual({
      base_tree: 'b'.repeat(40),
      tree: [{ path: 'src/banner.js', mode: '100644', type: 'blob', content: BANNER }],
    });
    expect(github[4]!.body).toEqual({ ref: 'refs/heads/agents-foundry/ui-7', sha: 'd'.repeat(40) });
    expect(github[5]!.body).toMatchObject({
      draft: true,
      head: 'agents-foundry/ui-7',
      base: 'main',
    });
    const final = toolResults(modelRequests.at(-1)!).at(-1)!.content;
    expect(final).toBe(
      'Opened draft pull request #42 (https://github.com/acme/storefront/pull/42) from agents-foundry/ui-7.',
    );
    const grants = sql()
      .prepare('SELECT signed_grant FROM agent_execution_grants ORDER BY issued_at, rowid')
      .all()
      .map((row) => (JSON.parse(String(row['signed_grant'])) as SignedExecutionGrant).payload);
    expect(grants.map((grant) => [grant.action, grant.isolation])).toEqual([
      ['repository.read', 'sandboxed'],
      ['repository.write', 'sandboxed'],
      ['workspace.command', 'sandboxed'],
    ]);
    expect(JSON.stringify(sql().prepare('SELECT * FROM audit_events').all())).not.toContain(
      'github-test-token',
    );
  });

  it('denies pull requests without changes or outside the configured repository', async () => {
    const proposal = {
      repository: 'acme/storefront',
      baseBranch: 'main',
      headBranch: 'agents-foundry/ui-7',
      title: 'Nothing yet',
      body: '',
      path: 'repo',
    };
    scenario = [
      ['source-control', proposal],
      [
        'repository',
        {
          kind: 'git.checkout',
          repositoryUrl: 'https://github.com/acme/storefront',
          ref: 'main',
          path: 'repo',
        },
      ],
      ['code-editor', { kind: 'file.write', path: 'repo/src/banner.js', content: BANNER }],
      ['source-control', { ...proposal, repository: 'acme/payments' }],
      ['source-control', { ...proposal, headBranch: 'main' }],
    ];
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId, task: { objective: 'Propose', inputs: {} } })
      .expect(202);
    await host.pollOnce();
    await host.drain();
    expect(toolResults(modelRequests.at(-1)!).map((block) => block.content)).toEqual([
      'ACTION_DENIED: CHANGE_SET_EMPTY',
      expect.stringContaining('Checked out main'),
      `Created repo/src/banner.js (${Buffer.byteLength(BANNER)} bytes).`,
      'ACTION_DENIED: The target resource is outside the configured scope.',
      expect.stringMatching(/^TOOL_INPUT_INVALID: headBranch/),
    ]);
    expect(github).toEqual([]);
    // GitHub connections name repositories as owner/name; other shapes are refused.
    const authorize = db.structure.authorize;
    db.structure.authorize = () => undefined;
    try {
      for (const settings of [
        { allowedRepositories: ['not a repo'] },
        { allowedRepositories: ['acme/x', 'ACME/X'] },
        { allowedProjects: ['UI'] },
      ])
        expect(() =>
          db.connectors.create(admin, {
            provider: 'github',
            name: 'Other',
            baseUrl: 'https://api.github.com',
            secretRef: 'secret://github-token',
            settings,
          }),
        ).toThrow();
    } finally {
      db.structure.authorize = authorize;
    }
    expect(db.connectors.active(org, 'github')?.settings).toEqual({
      allowedProjects: [],
      allowedRepositories: ['acme/storefront'],
    });
  });

  it('runs in a conversation of the same agent and reports back into it', async () => {
    scenario = [];
    const chat = (
      await demoRequest(app)
        .post('/api/conversations')
        .send({ employeeId: employee.id, agentId, title: 'UI-7' })
        .expect(201)
    ).body as { id: string };
    const task = { objective: 'Implement UI-7', workflow: 'implement-ui-change', inputs: {} };
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, conversationId: chat.id, task })
        .expect(202)
    ).body as { threadId: string };
    await host.pollOnce();
    await host.drain();
    const messages = (await demoRequest(app).get(`/api/conversations/${chat.id}`).expect(200)).body
      .messages as { author: string; content: string }[];
    expect(messages).toEqual([
      expect.objectContaining({
        author: 'AGENT',
        content: 'UI-7 implemented and proposed as a draft pull request.',
      }),
    ]);
    expect(
      sql().prepare('SELECT conversation_id FROM agent_threads WHERE id=?').get(run.threadId),
    ).toEqual({ conversation_id: chat.id });
    const other = (
      await demoRequest(app)
        .post('/api/conversations')
        .send({ employeeId: employee.id, agentId: 'agent_qa_engineer', title: 'QA' })
        .expect(201)
    ).body as { id: string };
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId, conversationId: other.id, task })
      .expect(409, { error: 'CONVERSATION_AGENT_MISMATCH' });
    await demoRequest(app)
      .post('/api/execution/v1/runs')
      .send({ agentId, conversationId: chat.id, threadId: run.threadId, task })
      .expect(400);
  });

  it('refuses to publish a change set that changed after approval', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({
          agentId,
          task: { objective: 'Implement UI-7', workflow: 'implement-ui-change', inputs: {} },
        })
        .expect(202)
    ).body as { id: string };
    await host.pollOnce();
    await host.drain();
    const approval = db.execution
      .getRun(employee, run.id)
      .approvals.find((item) => item.status === 'PENDING')!;
    // Simulate a write recorded after the decision: the approved digest no longer matches.
    const write = sql()
      .prepare("SELECT * FROM agent_action_requests WHERE action='repository.write'")
      .get() as Record<string, string>;
    sql()
      .prepare(
        `INSERT INTO agent_action_requests (id, organization_id, run_id, step_id, runtime_id, action, tool_id,
         request_hash, decision, risk, reason, approval_id, created_at, parameters, policy_id, policy_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '00000000-0000-4000-8000-000000000001',
        org,
        write['run_id']!,
        write['step_id']!,
        write['runtime_id']!,
        'repository.write',
        'code-editor',
        'f'.repeat(64),
        'ALLOWED',
        'LOW',
        'late write',
        null,
        new Date(Date.now() + 1000).toISOString(),
        JSON.stringify({ kind: 'file.write', path: 'repo/src/extra.js', content: 'x' }),
        null,
        null,
      );
    sql()
      .prepare(
        `INSERT INTO agent_execution_grants (grant_id, request_id, organization_id, run_id, operation_kind,
         signed_grant, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
        org,
        write['run_id']!,
        'file.write',
        '{}',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    await request(app)
      .post(`/api/approvals/${approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    await host.pollOnce();
    await host.drain();
    const final = toolResults(modelRequests.at(-1)!).at(-1)!.content;
    expect(final).toBe('CHANGE_SET_CHANGED: The workspace changed after the decision.');
    expect(github.filter((call) => call.method === 'POST')).toEqual([]);
  });
});

describe('platform code stays role-agnostic (ADR 0009)', () => {
  it('names no role outside the catalog, except the documented legacy QA compatibility', () => {
    const apps = join(import.meta.dirname, '..', '..');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    for (const app of ['agent-runtime', 'execution-runtime', 'control-plane-api'])
      walk(join(apps, app, 'src'));
    // The pre-V2 demo agent and `/api/qa/runs` (legacy route, Phase F) are QA by design.
    const legacyQa = new Set([
      'control-plane-api/src/database.ts',
      'control-plane-api/src/execution/execution-service.ts',
    ]);
    const roleNames =
      /qa-engineer|qa_engineer|frontend-engineer|validate-story|implement-ui-change/;
    const offenders = files
      .map((file) => relative(apps, file).split('\\').join('/'))
      .filter((file) => roleNames.test(readFileSync(join(apps, file), 'utf8')))
      .filter((file) => !legacyQa.has(file));
    expect(offenders).toEqual([]);
    for (const file of legacyQa)
      expect(readFileSync(join(apps, file), 'utf8')).not.toMatch(
        /frontend-engineer|implement-ui-change/,
      );
  });
});
