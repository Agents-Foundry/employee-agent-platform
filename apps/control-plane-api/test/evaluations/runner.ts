/**
 * Generic governance evaluation runner (ADR 0019). It knows no role: everything comes from the
 * blueprint and its evaluation suite. A scripted model replays the scenario's tool calls
 * through the real control plane, agent runtime and execution runtime; the simulated world
 * (issue tracker, source control, repository checkout) comes from the suite.
 *
 * Commands, installs and browser runs are recorded, not executed: the execution runtime's own
 * tests run those operations for real. What is evaluated is governance and role wiring.
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
  EvaluationScenario,
  EvaluationSuiteDefinition,
  ExecutionOperation,
  ResourceLimits,
} from '@agents-foundry/contracts';
import { createApp } from '../../src/app.js';
import { MemorySecretStore } from '../../src/actions/secrets.js';
import type { AuthConfig } from '../../src/auth.js';
import { manifestSubject } from '../../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../../agent-runtime/src/kernel/native-kernel.js';
import {
  ModelGateway,
  type ModelRequest,
  type ModelResponse,
} from '../../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../../agent-runtime/src/models/scripted-provider.js';
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
const MODEL_PROVIDER = 'evaluation-model';
const RECORDED = '[recorded, not executed]';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const header = (actor: { id: string; role: string; organizationId: string }) => ({
  'x-actor-id': actor.id,
  'x-actor-role': actor.role,
  'x-organization-id': actor.organizationId,
});

/** Connection settings the runner can simulate, by connector provider. */
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

export interface ScenarioReport {
  /** Every mismatch between the scenario's expectations and what happened. */
  failures: string[];
  results: { tool: string; content: string; isError: boolean }[];
}

/** Checkouts produce the suite's files; commands, installs and browser runs are recorded. */
class WorldProvider implements ExecutionProvider {
  readonly id = 'evaluation-world';
  readonly isolation = 'local' as const;
  readonly enforces;
  private readonly inner = new LocalExecutionProvider();

  constructor(private readonly files: Record<string, string>) {
    this.enforces = this.inner.enforces;
  }

  async execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const done = (output: string): ProviderOutcome => ({
      status: 'SUCCEEDED',
      output,
      truncated: false,
      artifacts: [],
    });
    switch (operation.kind) {
      case 'git.checkout': {
        for (const [path, content] of Object.entries(this.files)) {
          const target = join(workspace.root, operation.path, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
        return done(`Checked out ${operation.ref} into ${operation.path}.`);
      }
      case 'command':
        return done(`${RECORDED} ${operation.command} ${operation.args.join(' ')}`);
      case 'dependencies.install':
        return done(`${RECORDED} npm ci from ${operation.registryUrl}`);
      case 'playwright.run':
        return done(`${RECORDED} Playwright ${operation.project} against ${operation.baseUrl}`);
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

const toolResults = (req: ModelRequest) =>
  req.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
  );

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

/** Runs one scenario against one blueprint version and reports every expectation it misses. */
export async function runScenario(
  blueprint: AgentBlueprintVersionDefinition,
  suite: EvaluationSuiteDefinition,
  scenario: EvaluationScenario,
): Promise<ScenarioReport> {
  const failures: string[] = [];
  const requests: ModelRequest[] = [];
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
    // The agent, as an admin would provision it, with the scenario's answers.
    const pending = await db.requestProvisioning(
      EMPLOYEE.id,
      {
        blueprintId: blueprint.id,
        blueprintVersion: blueprint.version,
        provider: MODEL_PROVIDER,
        model: 'scripted',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: scenario.answers,
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
          const answer = scenario.answers[connector.selection.questionId];
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
    const provider = new WorldProvider(suite.world.repositoryFiles);
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
    host = new RuntimeHost({
      controlPlane: new ControlPlaneClient({
        baseUrl: controlUrl,
        runtimeId: 'runtime-evaluation',
        privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway(
        [
          new ScriptedProvider(MODEL_PROVIDER, (req): ModelResponse => {
            requests.push(req);
            const next = scenario.steps[toolResults(req).length];
            const usage = { inputTokens: 1, outputTokens: 1 };
            if (next)
              return {
                content: [
                  {
                    type: 'tool_use',
                    id: `toolu_${toolResults(req).length}`,
                    name: next.tool,
                    input: next.input,
                  },
                ],
                stopReason: 'tool_use',
                usage,
              };
            return {
              content: [{ type: 'text', text: `Finished: ${scenario.task.objective}.` }],
              stopReason: 'end_turn',
              usage,
            };
          }),
        ],
        { resolve: async () => ({ apiKey: 'evaluation-only' }) },
      ),
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

    const run = (
      await request(app)
        .post('/api/execution/v1/runs')
        .set(header(EMPLOYEE))
        .send({
          agentId,
          task: {
            objective: scenario.task.objective,
            workflow: scenario.task.workflow,
            ...(scenario.task.workItemKey
              ? { workItem: { system: 'issue-tracker', key: scenario.task.workItemKey } }
              : {}),
            inputs: scenario.task.inputs ?? {},
          },
        })
    ).body as { id?: string; error?: string };
    if (!run.id) return { failures: [`run was not started: ${run.error}`], results: [] };

    // Drive the run; answer each approval as the scenario says.
    const decided = new Set<string>();
    const paused = new Set<number>();
    for (let round = 0; round <= scenario.steps.length + 2; round++) {
      await host.pollOnce();
      await host.drain();
      const detail = await db.execution.getRun(ADMIN, run.id);
      if (detail.run.status !== 'WAITING_FOR_APPROVAL') break;
      const approval = detail.approvals.find(
        (item) => item.status === 'PENDING' && !decided.has(item.id),
      );
      if (!approval) break;
      decided.add(approval.id);
      const index = requests.length ? toolResults(requests.at(-1)!).length : 0;
      paused.add(index);
      const step = scenario.steps[index];
      const expected = step?.expect.approval;
      if (!expected)
        failures.push(
          `step ${index + 1} (${step?.tool}) paused for ${approval.action} unexpectedly`,
        );
      else if (expected.action !== approval.action)
        failures.push(
          `step ${index + 1} (${step!.tool}) paused for ${approval.action}, expected ${expected.action}`,
        );
      await request(app)
        .post(`/api/approvals/${approval.id}/decision`)
        .set(header(ADMIN))
        .send({ decision: expected?.decision ?? 'REJECTED' });
    }

    // Tool results, step by step.
    const results = requests.length ? toolResults(requests.at(-1)!) : [];
    const rejectedAt = scenario.steps.findIndex(
      (step) => step.expect.approval?.decision === 'REJECTED',
    );
    const expectedResults = rejectedAt >= 0 ? rejectedAt : scenario.steps.length;
    if (results.length !== expectedResults)
      failures.push(`${results.length} tool results, expected ${expectedResults}`);
    scenario.steps.slice(0, expectedResults).forEach((step, index) => {
      const result = results[index];
      if (!result) return;
      const at = `step ${index + 1} (${step.tool})`;
      const outcome = !result.isError
        ? 'SUCCEEDED'
        : /^Tool .+ is not available\.$/.test(result.content)
          ? 'NOT_AVAILABLE'
          : 'FAILED';
      if (outcome !== step.expect.outcome)
        failures.push(`${at}: ${outcome}, expected ${step.expect.outcome}: ${result.content}`);
      const code = outcome === 'FAILED' ? result.content.split(':')[0] : undefined;
      if (step.expect.code && code !== step.expect.code)
        failures.push(`${at}: code ${code}, expected ${step.expect.code}`);
      if (step.expect.contains && !result.content.includes(step.expect.contains))
        failures.push(`${at}: result lacks "${step.expect.contains}": ${result.content}`);
      if (step.expect.approval && !paused.has(index))
        failures.push(`${at}: expected an approval for ${step.expect.approval.action}`);
    });
    if (rejectedAt >= 0 && !paused.has(rejectedAt))
      failures.push(`step ${rejectedAt + 1}: expected an approval to reject`);

    // The role as the model saw it, the run's outcome and what reached external systems.
    const first = requests[0];
    const offered = (first?.tools.map((tool) => tool.name) ?? []).sort();
    if (JSON.stringify(offered) !== JSON.stringify(scenario.expect.offeredTools))
      failures.push(
        `offered tools ${offered.join(',')}, expected ${scenario.expect.offeredTools.join(',')}`,
      );
    if (first && !first.system.includes(`Follow workflow ${scenario.task.workflow}@`))
      failures.push(`the prompt does not pin workflow ${scenario.task.workflow}`);
    const status = (await db.execution.getRun(ADMIN, run.id)).run.status;
    if (status !== scenario.expect.runStatus)
      failures.push(`run ${status}, expected ${scenario.expect.runStatus}`);
    const executed = (
      await rawSql(db)
        .prepare(
          `SELECT r.action FROM agent_action_executions e JOIN agent_action_requests r ON r.id=e.request_id
           WHERE e.status='SUCCEEDED' ORDER BY e.started_at, r.seq`,
        )
        .all<{ action: string }>()
    ).map((row) => row.action);
    if (JSON.stringify(executed) !== JSON.stringify(scenario.expect.executedActions))
      failures.push(
        `executed actions ${executed.join(',') || 'none'}, expected ${scenario.expect.executedActions.join(',') || 'none'}`,
      );
    return {
      failures,
      results: results.map((result, index) => ({
        tool: scenario.steps[index]?.tool ?? '?',
        content: result.content,
        isError: result.isError,
      })),
    };
  } finally {
    await host?.drain();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    state.close();
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
