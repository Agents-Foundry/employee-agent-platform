import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  AgentRunDetail,
  Approval,
  ConnectorConnection,
  RunActionSummary,
} from '@agents-foundry/contracts';
import { scrub } from './validate.js';

/**
 * The production-like smoke test (ADR 0039): one QA run on the deployed pilot stack, through
 * the same API a pilot user has, from story read to an approved draft write. It is opt-in, it
 * refuses to run for pull requests, and it writes only to dedicated, disposable resources:
 * before anything starts it checks that the organization's connections cannot reach anything
 * else, and it approves only writes aimed at those resources.
 */

export type SmokeProof =
  'sandbox-live' | 'private-scm-live' | 'real-model-live' | 'object-store-live' | 'vault-live';
export type StepStatus = 'passed' | 'failed' | 'not-run';

export interface SmokeConfig {
  baseUrl: string;
  origin: string;
  organizationId: string;
  agentId: string;
  storyKey: string;
  targetUrl: string;
  /** The disposable issue-tracker project drafts may be filed in. */
  jiraProject: string;
  /** The disposable repository draft pull requests may be opened in, if any. */
  repository: string | null;
  employee: { email: string; password: string };
  admin: { email: string; password: string };
  timeoutMs: number;
}

export interface SmokeStep {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
}

export interface SmokeReport {
  kind: 'pilot-smoke';
  version: 1;
  generatedAt: string;
  commit: string | null;
  environment: string;
  runId: string | null;
  steps: SmokeStep[];
  proofs: Record<SmokeProof, 'passed' | 'failed' | 'not-run'>;
  passed: boolean;
  redactions: number;
}

/** GitHub events that run code from a pull request, or on its behalf. Never allowed. */
const UNTRUSTED_EVENTS = [
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'merge_group',
  'workflow_run',
];

/** The guard and the configuration. Throws, naming the variable, when it may not run. */
export function smokeConfig(env: NodeJS.ProcessEnv): SmokeConfig {
  const refuse = (why: string): never => {
    throw new Error(`PILOT_SMOKE_REFUSED: ${why}`);
  };
  if (env['PILOT_SMOKE'] !== 'true') refuse('PILOT_SMOKE is not true; the suite is opt-in.');
  const event = env['GITHUB_EVENT_NAME']?.trim();
  if (event && UNTRUSTED_EVENTS.includes(event)) refuse(`it never runs for ${event} events.`);
  if (env['PILOT_SMOKE_RESOURCES_DISPOSABLE'] !== 'true')
    refuse('PILOT_SMOKE_RESOURCES_DISPOSABLE must state that the targets are disposable.');
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) refuse(`${name} is not set.`);
    return value!;
  };
  const baseUrl = new URL(required('PILOT_BASE_URL'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
  if (baseUrl.protocol !== 'https:' && !local) refuse('PILOT_BASE_URL must be HTTPS.');
  const jiraProject = required('PILOT_SMOKE_JIRA_PROJECT');
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(jiraProject)) refuse('PILOT_SMOKE_JIRA_PROJECT is not a key.');
  const repository = env['PILOT_SMOKE_REPOSITORY']?.trim() || null;
  if (repository && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository))
    refuse('PILOT_SMOKE_REPOSITORY must be owner/name.');
  const credentials = (name: string) => {
    let parsed: { email?: unknown; password?: unknown };
    try {
      parsed = JSON.parse(readFileSync(required(name), 'utf8')) as typeof parsed;
    } catch {
      return refuse(`${name} does not name a readable JSON file.`);
    }
    if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string')
      refuse(`${name} must hold an email and a password.`);
    return { email: parsed.email as string, password: parsed.password as string };
  };
  const employee = credentials('PILOT_SMOKE_EMPLOYEE_CREDENTIALS_PATH');
  const admin = credentials('PILOT_SMOKE_ADMIN_CREDENTIALS_PATH');
  if (employee.email.toLowerCase() === admin.email.toLowerCase())
    refuse('the employee and the approving administrator must be different people.');
  return {
    baseUrl: baseUrl.origin,
    origin: new URL(required('PILOT_SMOKE_ORIGIN')).origin,
    organizationId: required('PILOT_SMOKE_ORGANIZATION_ID'),
    agentId: required('PILOT_SMOKE_AGENT_ID'),
    storyKey: required('PILOT_SMOKE_STORY_KEY'),
    targetUrl: required('PILOT_SMOKE_TARGET_URL'),
    jiraProject,
    repository,
    employee,
    admin,
    timeoutMs: Number(env['PILOT_SMOKE_TIMEOUT_MS'] ?? 30 * 60_000),
  };
}

/** What the smoke needs from the control plane, as one signed-in person. */
export interface SmokeSession {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  bytes(path: string): Promise<Buffer>;
}

export class SmokeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP_${status}_${code}`);
  }
}

/** Signs in with a password and keeps the session cookie; nothing else is stored. */
export async function signIn(
  config: Pick<SmokeConfig, 'baseUrl' | 'origin'>,
  person: { email: string; password: string },
  client: 'admin' | 'employee',
  fetcher: typeof fetch = fetch,
): Promise<SmokeSession> {
  const login = await fetcher(new URL('/api/auth/password', config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: config.origin },
    body: JSON.stringify({ ...person, client }),
    redirect: 'manual',
  });
  await login.arrayBuffer().catch(() => undefined);
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0]!)
    .find((value) => value.startsWith('af_session='));
  if (!login.ok || !cookie) throw new SmokeHttpError(login.status, 'SIGN_IN_FAILED');
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetcher(new URL(path, config.baseUrl), {
      method,
      headers: {
        cookie,
        origin: config.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new SmokeHttpError(
        response.status,
        typeof error.error === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.error)
          ? error.error
          : 'ERROR',
      );
    }
    return response;
  };
  return {
    get: async (path) => (await (await call('GET', path)).json()) as never,
    post: async (path, body) => (await (await call('POST', path, body)).json()) as never,
    bytes: async (path) => Buffer.from(await (await call('GET', path)).arrayBuffer()),
  };
}

/** Actions that change an external system, and the one resource each may change in a smoke. */
export function disposableTarget(
  approval: Pick<Approval, 'action' | 'resourceType' | 'resourceId'>,
  config: Pick<SmokeConfig, 'jiraProject' | 'repository'>,
): 'allowed' | 'refused' {
  if (approval.resourceType === 'issue-tracker.project')
    return approval.action === 'jira.issue.create' && approval.resourceId === config.jiraProject
      ? 'allowed'
      : 'refused';
  if (approval.resourceType === 'repository')
    return approval.action === 'repository.pull_request.create' &&
      !!config.repository &&
      approval.resourceId.toLowerCase() === config.repository.toLowerCase()
      ? 'allowed'
      : 'refused';
  if (/^(jira|repository|github)\./.test(approval.action)) return 'refused';
  // Execution in the agent's own sandbox (for example the browser run) changes nothing outside.
  return 'allowed';
}

/** Connections whose scope reaches beyond the disposable resources. */
export function connectionsBeyond(
  connections: readonly ConnectorConnection[],
  config: Pick<SmokeConfig, 'jiraProject' | 'repository'>,
): string[] {
  return connections
    .filter((connection) => connection.status === 'ACTIVE')
    .flatMap((connection) => {
      const projects = connection.settings.allowedProjects ?? [];
      const repositories = connection.settings.allowedRepositories ?? [];
      const extraProjects = projects.filter((project) => project !== config.jiraProject);
      const extraRepositories = repositories.filter(
        (repository) => repository.toLowerCase() !== config.repository?.toLowerCase(),
      );
      return [...extraProjects, ...extraRepositories].length
        ? [`${connection.provider} connection ${connection.id}`]
        : [];
    });
}

const SMOKE_INSTRUCTIONS =
  'Pilot smoke test. Check out the repository, install its dependencies, run its unit tests, ' +
  'then run the Playwright suite against the target and keep the evidence. File at most one ' +
  'draft defect, in the configured project, describing what you found.';

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

export interface SmokeDependencies {
  employee: SmokeSession;
  admin: SmokeSession;
  sleep(ms: number): Promise<void>;
  now(): number;
  commit: string | null;
  environment: string;
  /** Values that must never appear in the report (the passwords). */
  secrets: string[];
}

export async function runSmoke(config: SmokeConfig, deps: SmokeDependencies): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  const step = (id: string, title: string, status: StepStatus, detail: string) =>
    steps.push({ id, title, status, detail });
  const finish = (runId: string | null): SmokeReport => {
    const passed = (id: string) => steps.find((item) => item.id === id)?.status === 'passed';
    const failedAny = (ids: string[]) =>
      ids.some((id) => steps.find((item) => item.id === id)?.status === 'failed');
    const proof = (ids: string[]) =>
      ids.every(passed) ? 'passed' : failedAny(ids) ? 'failed' : 'not-run';
    const report: SmokeReport = {
      kind: 'pilot-smoke',
      version: 1,
      generatedAt: new Date(deps.now()).toISOString(),
      commit: deps.commit,
      environment: deps.environment,
      runId,
      steps,
      proofs: {
        'private-scm-live': proof(['private-checkout']),
        'sandbox-live': proof(['dependency-install', 'sandboxed-test', 'playwright-run']),
        'real-model-live': proof(['real-model', 'run-completed']),
        'object-store-live': proof(['evidence-stored', 'evidence-retrieved']),
        'vault-live': proof(['story-read', 'real-model']),
      },
      passed: steps.length > 0 && steps.every((item) => item.status === 'passed'),
      redactions: 0,
    };
    return scrub(report, deps.secrets);
  };
  const code = (error: unknown) =>
    error instanceof SmokeHttpError ? error.message : (error as Error).message.slice(0, 120);

  // 1. Who is signed in, and that it is the dedicated test organization.
  try {
    const [employee, admin] = await Promise.all([
      deps.employee.get<{ id: string; organizationId: string; role: string }>('/api/auth/session'),
      deps.admin.get<{ id: string; organizationId: string; role: string }>('/api/auth/session'),
    ]);
    if (
      employee.organizationId !== config.organizationId ||
      admin.organizationId !== config.organizationId
    )
      throw new Error('A session is not in the dedicated test organization.');
    if (employee.role !== 'EMPLOYEE' || admin.role !== 'ADMIN' || employee.id === admin.id)
      throw new Error('Expected one employee and a different administrator.');
    step(
      'sessions',
      'Signed in to the dedicated test organization',
      'passed',
      'Employee and administrator.',
    );
  } catch (error) {
    step('sessions', 'Signed in to the dedicated test organization', 'failed', code(error));
    return finish(null);
  }

  // 2. Nothing the agent can write to lies outside the disposable resources.
  try {
    const beyond = connectionsBeyond(
      await deps.admin.get<ConnectorConnection[]>('/api/organization/connector-connections'),
      config,
    );
    if (beyond.length)
      throw new Error(`Allows resources beyond the disposable ones: ${beyond.join(', ')}.`);
    step(
      'write-scope',
      'Connections reach only the disposable resources',
      'passed',
      'Checked every active connection.',
    );
  } catch (error) {
    step('write-scope', 'Connections reach only the disposable resources', 'failed', code(error));
    return finish(null);
  }

  // 3. The agent uses a real model.
  try {
    const manifest = await deps.employee.get<{ payload: { model?: { provider?: string } } }>(
      `/api/agents/${encodeURIComponent(config.agentId)}/manifest`,
    );
    const provider = manifest.payload.model?.provider ?? '';
    if (!provider || /^(test|scripted|fake|mock)/i.test(provider))
      throw new Error(`The agent's model provider is not a real one (${provider || 'none'}).`);
    step('real-model', 'The agent uses a real model provider', 'passed', `Provider ${provider}.`);
  } catch (error) {
    step('real-model', 'The agent uses a real model provider', 'failed', code(error));
    return finish(null);
  }

  // 4. Start the QA run as the pilot user would.
  let runId: string;
  try {
    const conversation = await deps.employee.post<{ id: string }>('/api/conversations', {
      employeeId: (await deps.employee.get<{ id: string }>('/api/auth/session')).id,
      agentId: config.agentId,
      title: `Pilot smoke ${new Date(deps.now()).toISOString()}`,
    });
    const started = await deps.employee.post<{ mode: string; agentRun?: { id: string } }>(
      '/api/qa/runs',
      {
        employeeId: (await deps.employee.get<{ id: string }>('/api/auth/session')).id,
        conversationId: conversation.id,
        storyKey: config.storyKey,
        targetUrl: config.targetUrl,
        instructions: SMOKE_INSTRUCTIONS,
      },
    );
    if (started.mode !== 'GENERIC_RUNTIME' || !started.agentRun)
      throw new Error(`The QA run did not start on the generic runtime (${started.mode}).`);
    runId = started.agentRun.id;
    step('run-started', 'QA run started', 'passed', `Run ${runId}.`);
  } catch (error) {
    step('run-started', 'QA run started', 'failed', code(error));
    return finish(null);
  }

  // 5. Drive it: approve what may be approved, refuse anything else, until it ends.
  const runPath = `/api/execution/v1/runs/${runId}`;
  const decided = new Set<string>();
  const refused: string[] = [];
  let detail: AgentRunDetail | null = null;
  const deadline = deps.now() + config.timeoutMs;
  try {
    for (;;) {
      detail = await deps.employee.get<AgentRunDetail>(runPath);
      const status = detail.run.status;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) break;
      if (deps.now() > deadline) {
        await deps.employee.post(`${runPath}/cancel`, {}).catch(() => undefined);
        throw new Error('The run did not finish in time and was cancelled.');
      }
      if (status === 'WAITING_FOR_APPROVAL') {
        const pending = (await deps.admin.get<Approval[]>('/api/approvals')).filter(
          (approval) =>
            approval.runId === runId && approval.status === 'PENDING' && !decided.has(approval.id),
        );
        for (const approval of pending) {
          const verdict = disposableTarget(approval, config);
          decided.add(approval.id);
          if (verdict === 'refused') refused.push(`${approval.action} on ${approval.resourceType}`);
          await deps.admin.post(`/api/approvals/${approval.id}/decision`, {
            decision: verdict === 'allowed' ? 'APPROVED' : 'REJECTED',
          });
        }
      }
      await deps.sleep(5000);
    }
    if (refused.length)
      throw new Error(`Refused writes outside the disposable resources: ${refused.join(', ')}.`);
    if (detail.run.status !== 'COMPLETED')
      throw new Error(
        `The run ended ${detail.run.status} (${detail.run.statusReason ?? 'no reason'}).`,
      );
    step(
      'run-completed',
      'The run completed',
      'passed',
      `${detail.steps.length} steps, ${decided.size} approvals decided.`,
    );
  } catch (error) {
    step('run-completed', 'The run completed', 'failed', code(error));
  }

  // 6. What the run did, from the control plane's own records.
  let actions: RunActionSummary[] = [];
  try {
    actions = await deps.employee.get<RunActionSummary[]>(`${runPath}/actions`);
  } catch (error) {
    step('actions', 'Read what the run did', 'failed', code(error));
  }
  const did = (
    id: string,
    title: string,
    match: (action: RunActionSummary) => boolean,
    outcomes: RunActionSummary['outcome'][] = ['SUCCEEDED'],
  ) => {
    const found = actions.filter(match);
    step(
      id,
      title,
      found.some((action) => outcomes.includes(action.outcome)) ? 'passed' : 'failed',
      found.length
        ? found
            .map(
              (action) =>
                `${action.action}: ${action.outcome}${action.errorCode ? ` (${action.errorCode})` : ''}`,
            )
            .join('; ')
        : 'Not requested by the run.',
    );
  };
  did('story-read', 'Story read from the issue tracker', (a) => a.action === 'jira.read');
  did(
    'private-checkout',
    'Private repository checked out with a brokered credential',
    (a) => a.operationKind === 'git.checkout' && a.credentialed,
  );
  did(
    'dependency-install',
    'Dependencies installed in the sandbox',
    (a) => a.operationKind === 'dependencies.install',
  );
  did('sandboxed-test', 'Project tests run in the sandbox', (a) => a.operationKind === 'command');
  // Failing browser checks are a finding, not a broken stack: the run itself must have run.
  did(
    'playwright-run',
    'Playwright run in the sandbox',
    (a) => a.operationKind === 'playwright.run',
    ['SUCCEEDED', 'FAILED'],
  );
  did(
    'draft-write',
    'Draft write approved and made in the disposable target',
    (a) => a.action === 'jira.issue.create' || a.action === 'repository.pull_request.create',
  );

  // 7. Evidence: stored, and retrieved with its hash intact.
  const artifacts = detail?.artifacts ?? [];
  const evidence = artifacts.filter((artifact) =>
    ['playwright_trace', 'screenshot', 'test_report'].includes(artifact.type),
  );
  const browser = evidence.some((artifact) =>
    ['playwright_trace', 'screenshot'].includes(artifact.type),
  );
  step(
    'evidence-stored',
    'Trace or screenshot, and the report, stored',
    browser && evidence.some((artifact) => artifact.type === 'test_report') ? 'passed' : 'failed',
    `${artifacts.length} artifacts: ${[...new Set(artifacts.map((artifact) => artifact.type))].join(', ') || 'none'}.`,
  );
  try {
    if (!evidence.length) throw new Error('Nothing to retrieve.');
    for (const artifact of evidence) {
      const retrieval = await deps.employee.post<{ path: string }>(
        `/api/execution/v1/artifacts/${artifact.id}/retrievals`,
        {},
      );
      const content = await deps.employee.bytes(retrieval.path);
      if (sha256(content) !== artifact.checksum.value || content.byteLength !== artifact.sizeBytes)
        throw new Error(`Artifact ${artifact.id} did not match its record.`);
    }
    step(
      'evidence-retrieved',
      'Evidence retrieved, hashes verified',
      'passed',
      `${evidence.length} artifacts.`,
    );
  } catch (error) {
    step('evidence-retrieved', 'Evidence retrieved, hashes verified', 'failed', code(error));
  }
  return finish(runId);
}

export function summarizeSmoke(report: SmokeReport): string {
  const mark = { passed: 'PASS', failed: 'FAIL', 'not-run': 'SKIP' } as const;
  return `${[
    `Pilot smoke for ${report.environment}${report.runId ? `, run ${report.runId}` : ''}`,
    ...report.steps.map((item) => `  ${mark[item.status]}  ${item.title}\n        ${item.detail}`),
    `Operational proofs: ${Object.entries(report.proofs)
      .map(([proof, status]) => `${proof}=${status}`)
      .join(', ')}`,
    report.passed ? 'Smoke test passed.' : 'Smoke test FAILED.',
  ].join('\n')}\n`;
}
