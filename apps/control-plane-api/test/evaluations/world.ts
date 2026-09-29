/**
 * The evaluation environment shared by governance evaluations (ADR 0019) and model-quality
 * evaluations (ADR 0020): the real control plane, agent runtime and execution runtime, wired to
 * a simulated outside world taken from an evaluation suite. It knows no role.
 *
 * Checkouts produce the suite's files. Commands, installs and browser runs are never executed:
 * they return the task's simulated result, or are recorded as succeeded.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import type {
  AgentBlueprintVersionDefinition,
  EvaluationExecutionResult,
  EvaluationScenario,
  EvaluationSuiteDefinition,
  ExecutionOperation,
  ResourceLimits,
  RunApprovalSummary,
} from '@agents-foundry/contracts';
import { createApp } from '../../src/app.js';
import { MemorySecretStore } from '../../src/actions/secrets.js';
import type { AuthConfig } from '../../src/auth.js';
import { manifestSubject } from '../../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../../agent-runtime/src/manifest-verifier.js';
import {
  NativeKernel,
  type NativeKernelOptions,
} from '../../../agent-runtime/src/kernel/native-kernel.js';
import {
  ModelGateway,
  type CredentialBroker,
  type ModelProvider,
} from '../../../agent-runtime/src/models/model-gateway.js';
import { ToolRegistry } from '../../../agent-runtime/src/tools/runtime-tool.js';
import {
  BrowserTool,
  BuildTool,
  CodeEditorTool,
  DependencyTool,
  RepositoryTool,
} from '../../../agent-runtime/src/tools/execution-tools.js';
import { ArtifactTool } from '../../../agent-runtime/src/tools/artifact-tool.js';
import { IssueTrackerTool } from '../../../agent-runtime/src/tools/issue-tracker-tool.js';
import { SourceControlTool } from '../../../agent-runtime/src/tools/source-control-tool.js';
import { MemoryArtifactStore } from '../../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../../agent-runtime/src/checkpoints.js';
import { ExecutionService } from '../../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../../execution-runtime/src/artifact-store.js';
import { StateStore } from '../../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../../execution-runtime/src/server.js';
import { LocalExecutionProvider } from '../../../execution-runtime/src/providers/local-provider.js';
import type {
  ExecutionProvider,
  ProviderOutcome,
  WorkspaceHandle,
} from '../../../execution-runtime/src/providers/execution-provider.js';
import { testDatabase } from '../support/database.js';
import { rawSql } from '../support/raw-sql.js';

const ORGANIZATION = 'org_agents_foundry';
const EMPLOYEE = {
  id: 'employee_qa_demo',
  role: 'EMPLOYEE' as const,
  organizationId: ORGANIZATION,
};
const ADMIN = { id: 'admin_demo', role: 'ADMIN' as const, organizationId: ORGANIZATION };
const DEMO: AuthConfig = { mode: 'demo' };
export const RECORDED = '[recorded, not executed]';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const header = (actor: { id: string; role: string; organizationId: string }) => ({
  'x-actor-id': actor.id,
  'x-actor-role': actor.role,
  'x-organization-id': actor.organizationId,
});

/** Connection settings the environment can simulate, by connector provider. */
const PROVIDERS: Record<
  string,
  (suite: EvaluationSuiteDefinition) => { name: string; baseUrl: string; settings: object }
> = {
  jira: (suite) => ({
    name: 'Evaluation Jira',
    baseUrl: 'https://evaluation.atlassian.net',
    settings: { allowedProjects: suite.world.issueProjects },
  }),
  github: (suite) => ({
    name: 'Evaluation GitHub',
    baseUrl: 'https://api.github.com',
    settings: { allowedRepositories: suite.world.repositories },
  }),
};

/** Checkouts produce the suite's files; commands, installs and browser runs are simulated. */
class WorldProvider implements ExecutionProvider {
  readonly id = 'evaluation-world';
  readonly isolation = 'local' as const;
  readonly enforces;
  private readonly inner = new LocalExecutionProvider();

  constructor(
    private readonly files: Record<string, string>,
    private readonly results: readonly EvaluationExecutionResult[],
  ) {
    this.enforces = this.inner.enforces;
  }

  async execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const simulated = (line: string, recorded: string): ProviderOutcome => {
      const result = this.results.find(
        (item) => item.operation === operation.kind && line.includes(item.match),
      );
      if (result?.status === 'FAILED')
        return {
          status: 'FAILED',
          exitCode: 1,
          error: { code: 'EXECUTION_FAILED', message: 'The operation exited with code 1.' },
          output: result.output,
          truncated: false,
          artifacts: [],
        };
      return {
        status: 'SUCCEEDED',
        output: result?.output ?? recorded,
        truncated: false,
        artifacts: [],
      };
    };
    switch (operation.kind) {
      case 'git.checkout': {
        for (const [path, content] of Object.entries(this.files)) {
          const target = join(workspace.root, operation.path, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
        return {
          status: 'SUCCEEDED',
          output: `Checked out ${operation.ref} into ${operation.path}.`,
          truncated: false,
          artifacts: [],
        };
      }
      case 'command': {
        const line = `${operation.command} ${operation.args.join(' ')}`;
        return simulated(line, `${RECORDED} ${line}`);
      }
      case 'dependencies.install':
        return simulated(operation.registryUrl, `${RECORDED} npm ci from ${operation.registryUrl}`);
      case 'playwright.run':
        return simulated(
          `${operation.project} ${operation.baseUrl}`,
          `${RECORDED} Playwright ${operation.project} against ${operation.baseUrl}`,
        );
      default:
        return this.inner.execute(workspace, operation, limits, signal);
    }
  }
}

/** Issue tracker and source control endpoints, answered from the suite's world. */
function worldFetch(suite: EvaluationSuiteDefinition): typeof fetch {
  let created = 0;
  return async (url, init) => {
    const target = new URL(String(url));
    const method = String(init?.method ?? 'GET');
    if (target.hostname === 'evaluation.atlassian.net') {
      const read = /^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/.exec(target.pathname);
      if (read && method === 'GET') {
        const issue = suite.world.issues.find((item) => item.key === read[1]);
        return issue
          ? Response.json({
              key: issue.key,
              fields: {
                summary: issue.summary,
                status: { name: 'Ready' },
                issuetype: { name: issue.type },
                description: issue.description,
              },
            })
          : new Response('{}', { status: 404 });
      }
      if (target.pathname === '/rest/api/3/issue' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { fields: { project: { key: string } } };
        created++;
        return Response.json(
          { id: String(1000 + created), key: `${body.fields.project.key}-${100 + created}` },
          { status: 201 },
        );
      }
    }
    if (target.hostname === 'api.github.com') {
      const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(target.pathname);
      if (match && suite.world.repositories.includes(match[1]!)) {
        const [, repository, path] = match;
        const sha = (c: string) => c.repeat(40);
        if (path === '/git/ref/heads/main') return Response.json({ object: { sha: sha('a') } });
        if (path === `/git/commits/${sha('a')}`) return Response.json({ tree: { sha: sha('b') } });
        if (path === '/git/trees') return Response.json({ sha: sha('c') }, { status: 201 });
        if (path === '/git/commits') return Response.json({ sha: sha('d') }, { status: 201 });
        if (path === '/git/refs') return Response.json({ ref: 'x' }, { status: 201 });
        if (path === '/pulls')
          return Response.json(
            { number: 7, html_url: `https://github.com/${repository}/pull/7` },
            { status: 201 },
          );
      }
    }
    return new Response('{}', { status: 404 });
  };
}

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

export interface EvaluationEnvironmentOptions {
  blueprint: AgentBlueprintVersionDefinition;
  suite: EvaluationSuiteDefinition;
  answers: Record<string, string | string[]>;
  /** The model the agent is provisioned with; the manifest pins its provider and model id. */
  model: { provider: ModelProvider; model: string; credentials: CredentialBroker };
  kernel?: NativeKernelOptions;
  executionResults?: readonly EvaluationExecutionResult[];
}

export interface EvaluationEnvironment {
  /** Starts a run of the provisioned agent as its employee would. */
  startRun(task: EvaluationScenario['task']): Promise<{ id?: string; error?: string }>;
  /**
   * Lets the runtime work until the run no longer waits for an approval, answering each
   * approval with `decide`, for at most `rounds` approvals.
   */
  drive(
    runId: string,
    decide: (approval: RunApprovalSummary) => 'APPROVED' | 'REJECTED',
    rounds: number,
  ): Promise<void>;
  runStatus(runId: string): Promise<string>;
  /** Control-plane actions that reached an external system and succeeded, in order. */
  executedActions(): Promise<string[]>;
}

/** Provisions the agent and its connections, starts every service, and tears them down. */
export async function withEvaluationEnvironment<T>(
  options: EvaluationEnvironmentOptions,
  body: (environment: EvaluationEnvironment) => Promise<T>,
): Promise<T> {
  const { blueprint, suite, answers } = options;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secrets = new MemorySecretStore();
  for (const provider of Object.keys(PROVIDERS))
    secrets.set(ORGANIZATION, `${provider}-token`, 'eval');
  const db = await testDatabase({
    manifestV2Issuance: true,
    genericRuntime: true,
    secrets,
    connectorFetch: worldFetch(suite),
    runtimeIdentities: [
      {
        id: 'runtime-evaluation',
        publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        organizations: [ORGANIZATION],
        runtimeProfiles: [blueprint.runtime.profile],
      },
    ],
  });
  const root = mkdtempSync(join(tmpdir(), 'af-evaluation-'));
  const state = new StateStore(':memory:');
  const servers: Server[] = [];
  let host: RuntimeHost | undefined;
  try {
    // The agent, as an admin would provision it, with the given answers.
    const pending = await db.requestProvisioning(
      EMPLOYEE.id,
      {
        blueprintId: blueprint.id,
        blueprintVersion: blueprint.version,
        provider: options.model.provider.id,
        model: options.model.model,
        credentialMode: 'ORGANIZATION_MANAGED',
        answers,
      },
      ORGANIZATION,
    );
    const agentId = manifestSubject(
      (await db.decideProvisioning(pending.id, ORGANIZATION, ADMIN.id, 'APPROVED', 'Evaluation'))
        .manifest!.payload,
    ).agentId;
    // Connections for every connector provider the answers select.
    const authorize = db.structure.authorize;
    db.structure.authorize = async () => undefined; // The seeded demo admin has no membership.
    try {
      const providers = new Set(
        blueprint.connectors.flatMap((connector) => {
          const answer = answers[connector.selection.questionId];
          return (Array.isArray(answer) ? answer : [answer ?? ''])
            .map((option) => connector.selection.providers[option])
            .filter((provider): provider is string => Boolean(provider));
        }),
      );
      for (const provider of providers) {
        const connection = PROVIDERS[provider];
        if (!connection) throw new Error(`EVALUATION_PROVIDER_UNSUPPORTED: ${provider}`);
        await db.connectors.create(ADMIN, {
          provider,
          secretRef: `secret://${provider}-token`,
          ...connection(suite),
        });
      }
    } finally {
      db.structure.authorize = authorize;
    }

    const app = createApp(db, DEMO);
    const control = createServer(app);
    const provider = new WorldProvider(suite.world.repositoryFiles, options.executionResults ?? []);
    const execution = createExecutionServer(
      new ExecutionService({
        verifier: new GrantVerifier(db.signer.verificationKey.publicKeySpki),
        provider,
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        allowUnsandboxed: true,
      }),
      provider,
    );
    servers.push(control, execution);
    const [controlUrl, executionUrl] = await Promise.all([listen(control), listen(execution)]);
    const executionClient = new ExecutionClient(executionUrl);
    const runtime = new RuntimeHost({
      controlPlane: new ControlPlaneClient({
        baseUrl: controlUrl,
        runtimeId: 'runtime-evaluation',
        privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(options.kernel),
      models: new ModelGateway([options.model.provider], options.model.credentials),
      // The same tool implementations every runtime carries; the manifest decides what is offered.
      tools: new ToolRegistry([
        new ArtifactTool(),
        new IssueTrackerTool(),
        new SourceControlTool(),
        new RepositoryTool(executionClient),
        new BrowserTool(executionClient),
        new CodeEditorTool(executionClient),
        new BuildTool(executionClient),
        new DependencyTool(executionClient),
      ]),
      artifacts: new MemoryArtifactStore(),
      checkpoints: new MemoryCheckpointStore(),
      logger: silent,
    });
    host = runtime;

    return await body({
      async startRun(task) {
        return (
          await request(app)
            .post('/api/execution/v1/runs')
            .set(header(EMPLOYEE))
            .send({
              agentId,
              task: {
                objective: task.objective,
                workflow: task.workflow,
                ...(task.workItemKey
                  ? { workItem: { system: 'issue-tracker', key: task.workItemKey } }
                  : {}),
                inputs: task.inputs ?? {},
              },
            })
        ).body as { id?: string; error?: string };
      },
      async drive(runId, decide, rounds) {
        const decided = new Set<string>();
        for (let round = 0; round <= rounds; round++) {
          await runtime.pollOnce();
          await runtime.drain();
          const detail = await db.execution.getRun(ADMIN, runId);
          if (detail.run.status !== 'WAITING_FOR_APPROVAL') return;
          const approval = detail.approvals.find(
            (item) => item.status === 'PENDING' && !decided.has(item.id),
          );
          if (!approval) return;
          decided.add(approval.id);
          await request(app)
            .post(`/api/approvals/${approval.id}/decision`)
            .set(header(ADMIN))
            .send({ decision: decide(approval) });
        }
      },
      async runStatus(runId) {
        return (await db.execution.getRun(ADMIN, runId)).run.status;
      },
      async executedActions() {
        return (
          await rawSql(db)
            .prepare(
              `SELECT r.action FROM agent_action_executions e JOIN agent_action_requests r ON r.id=e.request_id
               WHERE e.status='SUCCEEDED' ORDER BY e.started_at, r.seq`,
            )
            .all<{ action: string }>()
        ).map((row) => row.action);
      },
    });
  } finally {
    await host?.drain();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    state.close();
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
