import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway, type ModelResponse } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import { RepositoryTool } from '../../agent-runtime/src/tools/execution-tools.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { ControlPlaneCredentialClient } from '../../execution-runtime/src/credential-client.js';
import { ExecutionService } from '../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../execution-runtime/src/artifact-store.js';
import { LocalExecutionProvider } from '../../execution-runtime/src/providers/local-provider.js';
import { StateStore } from '../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../execution-runtime/src/server.js';
import {
  gitServerAvailable,
  selfSignedCertificate,
  startGitServer,
  type GitServer,
} from '../../execution-runtime/test/support/git-server.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const employee = { id: 'employee_qa_demo', role: 'EMPLOYEE' as const, organizationId: org };
const admin: Actor = { id: 'admin_demo', role: 'ADMIN', organizationId: org };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const HOST = 'github.test';
const REPOSITORY = `https://${HOST}/acme/private.git`;
const TOKEN = `github_pat_${randomBytes(24).toString('hex')}`;
const FORMS = [
  TOKEN,
  Buffer.from(`x-access-token:${TOKEN}`).toString('base64'),
  encodeURIComponent(TOKEN),
];
const available = gitServerAvailable();

/** Every file under `directory` that contains the token in any form. */
function leaks(directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else {
        const content = readFileSync(child).toString('latin1');
        if (FORMS.some((form) => content.includes(form))) found.push(child);
      }
    }
  };
  walk(directory);
  return found;
}

describe.skipIf(!available)('private repository checkout end to end (ADR 0031)', () => {
  let fixtures: string;
  let git: GitServer;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let controlServer: Server;
  let executionServer: Server;
  let state: StateStore;
  let host: RuntimeHost;
  let root: string;
  let agentId: string;
  let artifacts: MemoryArtifactStore;
  /** Everything the model was ever sent. */
  let modelContext: string[];

  const listen = (server: Server) =>
    new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );

  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), 'af-private-e2e-'));
    const source = join(fixtures, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'README.md'), '# Private app\n');
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: source,
        stdio: 'pipe',
      });
    run('init', '-q', '-b', 'main');
    run('add', '-A');
    run('commit', '-q', '-m', 'initial');
    const projectRoot = join(fixtures, 'repos');
    mkdirSync(join(projectRoot, 'acme'), { recursive: true });
    execFileSync(
      'git',
      ['clone', '-q', '--bare', source, join(projectRoot, 'acme', 'private.git')],
      {
        stdio: 'pipe',
      },
    );
    git = await startGitServer({
      projectRoot,
      certificate: selfSignedCertificate(join(fixtures, 'tls'), [HOST]),
      credentials: `x-access-token:${TOKEN}`,
    });
  });
  afterAll(async () => {
    await git?.close();
    rmSync(fixtures, { recursive: true, force: true, maxRetries: 5 });
  });

  beforeEach(async () => {
    const agentKeys = generateKeyPairSync('ed25519');
    const executionKeys = generateKeyPairSync('ed25519');
    const spki = (key: typeof agentKeys.publicKey) =>
      key.export({ type: 'spki', format: 'der' }).toString('base64');
    const secrets = new MemorySecretStore();
    secrets.set(org, 'git-read', TOKEN);
    db = await testDatabase({
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      allowPrivateConnectorUrls: true,
      runtimeIdentities: [
        {
          id: 'runtime-agent',
          publicKeySpki: spki(agentKeys.publicKey),
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
        {
          id: 'runtime-execution',
          publicKeySpki: spki(executionKeys.publicKey),
          organizations: [org],
          runtimeProfiles: ['execution'],
          role: 'execution',
        },
      ],
    });
    // The demo administrator has no membership row; stand in for the real role check.
    db.structure.authorize = (async (actor: Actor) => {
      if (actor.role !== 'ADMIN' || actor.organizationId !== org)
        throw new Error('ORGANIZATION_ADMIN_REQUIRED');
    }) as never;
    await db.sourceControl.create(admin, {
      provider: 'github',
      name: 'GitHub read access',
      gitHost: HOST,
      apiBaseUrl: `https://api.${HOST}`,
      credentialMode: 'static_token',
      secretRef: 'secret://git-read',
      allowedRepositories: ['acme/private'],
    });
    const pending = await db.requestProvisioning(
      employee.id,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Checkout',
          repositoryUrl: REPOSITORY,
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
    app = createApp(db);
    controlServer = createServer(app);
    const controlUrl = await listen(controlServer);
    root = mkdtempSync(join(tmpdir(), 'af-private-e2e-run-'));
    state = new StateStore(join(root, 'state.db'));
    const provider = new LocalExecutionProvider({
      gitCaFile: git.caFile,
      egress: {
        lookup: async () => ['127.0.0.1'],
        isBlocked: () => false,
        portFor: () => git.port,
      },
    });
    executionServer = createExecutionServer(
      new ExecutionService({
        verifier: new GrantVerifier(db.signer.verificationKey.publicKeySpki),
        provider,
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        allowUnsandboxed: true,
        credentials: new ControlPlaneCredentialClient({
          controlPlaneUrl: controlUrl,
          runtimeId: 'runtime-execution',
          privateKey: executionKeys.privateKey,
        }),
      }),
      provider,
    );
    const execution = new ExecutionClient(await listen(executionServer));
    modelContext = [];
    artifacts = new MemoryArtifactStore();
    const script = (request: { messages: { content: { type: string }[] }[] }): ModelResponse => {
      modelContext.push(JSON.stringify(request));
      const results = request.messages.flatMap((message) =>
        message.content.filter((block) => block.type === 'tool_result'),
      ).length;
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (results === 0)
        return {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_checkout',
              name: 'repository',
              input: { kind: 'git.checkout', repositoryUrl: REPOSITORY, ref: 'main', path: 'repo' },
            },
          ],
          stopReason: 'tool_use',
          usage,
        };
      return { content: [{ type: 'text', text: 'Checked out.' }], stopReason: 'end_turn', usage };
    };
    host = new RuntimeHost({
      controlPlane: new ControlPlaneClient({
        baseUrl: controlUrl,
        runtimeId: 'runtime-agent',
        privateKey: agentKeys.privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway([new ScriptedProvider('test-provider', script)], {
        resolve: async () => ({ apiKey: 'test-only' }),
      }),
      tools: new ToolRegistry([new RepositoryTool(execution)]),
      artifacts,
      checkpoints: new MemoryCheckpointStore(),
      logger: silent,
    });
    git.requests.length = 0;
  });

  afterEach(async () => {
    await host.drain();
    await Promise.all([
      new Promise((resolve) => controlServer.close(resolve)),
      new Promise((resolve) => executionServer.close(resolve)),
    ]);
    state.close();
    await db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('checks out a private repository without the credential reaching anything but git', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'Read the private repository', inputs: {} } })
        .expect(202)
    ).body;
    await host.pollOnce();
    await host.drain();

    const detail = await db.execution.getRun(employee, run.id);
    expect(detail.run.status).toBe('COMPLETED');
    // The git host required the credential and received it, for this repository only.
    expect(git.requests.length).toBeGreaterThan(0);
    expect(git.requests.every((request) => request.authorization === `Basic ${FORMS[1]}`)).toBe(
      true,
    );
    const workspace = join(root, 'workspaces', readdirSync(join(root, 'workspaces'))[0]!);
    expect(readFileSync(join(workspace, 'repo', 'README.md'), 'utf8')).toBe('# Private app\n');

    // One lease: issued to the agent runtime's grant, redeemed and released by the execution runtime.
    const leases = await db.credentials.list(admin);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      status: 'RELEASED',
      outcome: 'SUCCEEDED',
      repository: 'acme/private',
      ref: 'main',
      runId: run.id,
    });
    const lifecycle = await rawSql(db)
      .prepare(
        "SELECT event_type, actor_id FROM audit_events WHERE event_type LIKE 'credential.%' ORDER BY created_at, id",
      )
      .all<{ event_type: string; actor_id: string }>();
    expect(lifecycle.map((event) => event.event_type).sort()).toEqual([
      'credential.lease.issued',
      'credential.lease.redeemed',
      'credential.lease.released',
    ]);

    // The model's context: the tool result is there, the credential is not.
    expect(modelContext).toHaveLength(2);
    expect(modelContext[1]).toContain('Checked out main of');
    // Every durable or visible place.
    const tables = await rawSql(db)
      .prepare(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      )
      .all<{ table_name: string }>();
    const rows: string[] = [];
    for (const { table_name } of tables)
      rows.push(
        ...(
          await rawSql(db)
            .prepare(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)
            .all<{ row: string }>()
        ).map((item) => item.row),
      );
    const visible = [
      ...modelContext,
      ...rows,
      JSON.stringify(detail),
      (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}/events`).expect(200)).text,
      JSON.stringify(await db.quality.overview(admin, {})),
      JSON.stringify(artifacts),
    ].join('\n');
    expect(visible).toContain('credential.lease.redeemed');
    for (const form of FORMS) expect(visible).not.toContain(form);
    // The execution runtime's workspace, scratch, artifacts and state.
    expect(leaks(root)).toEqual([]);
    expect(readFileSync(join(workspace, 'repo', '.git', 'config'), 'utf8')).toContain(
      `url = ${REPOSITORY}`,
    );
  });

  it('checks out nothing once the lease is revoked', async () => {
    // Revoke the lease between the grant and its use by disabling the connection.
    const connection = (await db.sourceControl.list(admin))[0]!;
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'Read the private repository', inputs: {} } })
        .expect(202)
    ).body;
    const original = db.credentials.redeem.bind(db.credentials);
    db.credentials.redeem = async (runtime, body) => {
      await db.sourceControl.disable(admin, connection.id, connection.version);
      return original(runtime, body);
    };
    await host.pollOnce();
    await host.drain();
    expect(git.requests).toEqual([]);
    expect((await db.credentials.list(admin))[0]).toMatchObject({
      status: 'REVOKED',
      revokeReason: 'CREDENTIAL_CONNECTION_INACTIVE',
    });
    // The model learns the checkout failed, by code only.
    expect(modelContext.at(-1)).toContain('CREDENTIAL_REFUSED');
    for (const form of FORMS) expect(modelContext.join('\n')).not.toContain(form);
    expect(
      readdirSync(join(root, 'workspaces')).flatMap((id) =>
        readdirSync(join(root, 'workspaces', id)),
      ),
    ).toEqual([]);
    expect((await db.execution.getRun(employee, run.id)).run.status).toBe('COMPLETED');
  });
});
