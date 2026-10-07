import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectionsBeyond,
  disposableTarget,
  runSmoke,
  smokeConfig,
  summarizeSmoke,
  type SmokeConfig,
  type SmokeSession,
} from '../../../packages/operations/src/smoke.js';

const EMPLOYEE_PASSWORD = 'employee-smoke-password-81';
const ADMIN_PASSWORD = 'admin-smoke-password-92';
const RUN = '7d1e5a4c-0b8f-4c3e-9a21-55f0c2d1e3b4';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('pilot smoke', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'af-smoke-'));
    writeFileSync(
      join(directory, 'employee.json'),
      JSON.stringify({ email: 'smoke-qa@pilot.example', password: EMPLOYEE_PASSWORD }),
    );
    writeFileSync(
      join(directory, 'admin.json'),
      JSON.stringify({ email: 'smoke-admin@pilot.example', password: ADMIN_PASSWORD }),
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PILOT_SMOKE: 'true',
    PILOT_SMOKE_RESOURCES_DISPOSABLE: 'true',
    PILOT_BASE_URL: 'https://agents.pilot.example',
    PILOT_SMOKE_ORIGIN: 'https://admin.pilot.example',
    PILOT_SMOKE_ORGANIZATION_ID: 'org-smoke',
    PILOT_SMOKE_AGENT_ID: 'agent-smoke',
    PILOT_SMOKE_STORY_KEY: 'SMOKE-1',
    PILOT_SMOKE_TARGET_URL: 'https://qa.pilot.example/cart',
    PILOT_SMOKE_JIRA_PROJECT: 'SMOKE',
    PILOT_SMOKE_REPOSITORY: 'acme/smoke-checkout',
    PILOT_SMOKE_EMPLOYEE_CREDENTIALS_PATH: join(directory, 'employee.json'),
    PILOT_SMOKE_ADMIN_CREDENTIALS_PATH: join(directory, 'admin.json'),
    ...extra,
  });

  it('runs only when asked, never for pull requests, and only against disposable targets', () => {
    expect(smokeConfig(env())).toMatchObject({ jiraProject: 'SMOKE', organizationId: 'org-smoke' });
    for (const [extra, why] of [
      [{ PILOT_SMOKE: undefined }, 'opt-in'],
      [{ GITHUB_EVENT_NAME: 'pull_request' }, 'pull_request'],
      [{ GITHUB_EVENT_NAME: 'pull_request_target' }, 'pull_request_target'],
      [{ GITHUB_EVENT_NAME: 'issue_comment' }, 'issue_comment'],
      [{ PILOT_SMOKE_RESOURCES_DISPOSABLE: 'false' }, 'disposable'],
      [{ PILOT_BASE_URL: 'http://agents.pilot.example' }, 'HTTPS'],
      [{ PILOT_SMOKE_JIRA_PROJECT: 'smoke' }, 'not a key'],
      [{ PILOT_SMOKE_ADMIN_CREDENTIALS_PATH: join(directory, 'employee.json') }, 'different'],
      [{ PILOT_SMOKE_AGENT_ID: '' }, 'PILOT_SMOKE_AGENT_ID'],
    ] as const)
      expect(() => smokeConfig(env(extra as NodeJS.ProcessEnv)), why).toThrow(why);
    expect(smokeConfig(env({ GITHUB_EVENT_NAME: 'workflow_dispatch' }))).toBeTruthy();
    // Only a manual dispatch from the default branch, in the protected environment.
    const workflow = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'pilot-smoke.yml'),
      'utf8',
    );
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/pull_request|push:|schedule:|workflow_run/);
    expect(workflow).toContain('environment: pilot');
  });

  it('approves only writes aimed at the disposable resources', () => {
    const config = { jiraProject: 'SMOKE', repository: 'acme/smoke-checkout' };
    const verdict = (action: string, resourceType: string, resourceId: string) =>
      disposableTarget({ action, resourceType, resourceId }, config);
    expect(verdict('jira.issue.create', 'issue-tracker.project', 'SMOKE')).toBe('allowed');
    expect(verdict('jira.issue.create', 'issue-tracker.project', 'PROD')).toBe('refused');
    expect(verdict('repository.pull_request.create', 'repository', 'ACME/smoke-checkout')).toBe(
      'allowed',
    );
    expect(verdict('repository.pull_request.create', 'repository', 'acme/checkout')).toBe(
      'refused',
    );
    expect(verdict('jira.issue.transition', 'issue-tracker.issue', 'SMOKE-1')).toBe('refused');
    expect(verdict('qa.execute_playwright', 'agent_run', RUN)).toBe('allowed');
    const connection = (provider: 'jira' | 'github', settings: object, status = 'ACTIVE') =>
      ({ id: `${provider}-1`, provider, status, settings }) as never;
    expect(
      connectionsBeyond(
        [
          connection('jira', { allowedProjects: ['SMOKE'] }),
          connection('github', {
            allowedProjects: [],
            allowedRepositories: ['acme/smoke-checkout'],
          }),
          connection('jira', { allowedProjects: ['PROD'] }, 'DISABLED'),
        ],
        config,
      ),
    ).toEqual([]);
    expect(
      connectionsBeyond([connection('jira', { allowedProjects: ['SMOKE', 'PROD'] })], config),
    ).toEqual(['jira connection jira-1']);
  });

  /** A deployed stack in miniature: just the API the smoke uses. */
  function stack(options: { writeTo?: string; connections?: object[] } = {}) {
    const calls: string[] = [];
    const decisions: Record<string, string> = {};
    let polls = 0;
    const trace = 'trace-zip-bytes';
    const report = '{"suites":[]}';
    const approvals = [
      {
        id: 'ap-1',
        runId: RUN,
        status: 'PENDING',
        action: 'qa.execute_playwright',
        resourceType: 'agent_run',
        resourceId: RUN,
      },
      {
        id: 'ap-2',
        runId: RUN,
        status: 'PENDING',
        action: 'jira.issue.create',
        resourceType: 'issue-tracker.project',
        resourceId: options.writeTo ?? 'SMOKE',
      },
    ];
    const artifacts = [
      {
        id: 'a-trace',
        type: 'playwright_trace',
        checksum: { value: sha(trace) },
        sizeBytes: trace.length,
      },
      {
        id: 'a-report',
        type: 'test_report',
        checksum: { value: sha(report) },
        sizeBytes: report.length,
      },
    ];
    const session = (who: 'employee' | 'admin'): SmokeSession => ({
      async get(path: string) {
        calls.push(`${who} GET ${path}`);
        if (path === '/api/auth/session')
          return (
            who === 'employee'
              ? { id: 'emp-1', organizationId: 'org-smoke', role: 'EMPLOYEE' }
              : { id: 'adm-1', organizationId: 'org-smoke', role: 'ADMIN' }
          ) as never;
        if (path === '/api/organization/connector-connections')
          return (options.connections ?? [
            {
              id: 'jira-1',
              provider: 'jira',
              status: 'ACTIVE',
              settings: { allowedProjects: ['SMOKE'] },
            },
          ]) as never;
        if (path === '/api/agents/agent-smoke/manifest')
          return { payload: { model: { provider: 'anthropic' } } } as never;
        if (path === '/api/approvals')
          return approvals.filter((item) => !decisions[item.id]).slice(0, 1) as never;
        if (path === `/api/execution/v1/runs/${RUN}`) {
          polls += 1;
          const done = Object.keys(decisions).length === approvals.length;
          return {
            run: {
              status: done
                ? Object.values(decisions).includes('REJECTED')
                  ? 'FAILED'
                  : 'COMPLETED'
                : 'WAITING_FOR_APPROVAL',
              statusReason: null,
            },
            steps: [{}, {}],
            approvals: [],
            artifacts: done ? artifacts : [],
          } as never;
        }
        if (path === `/api/execution/v1/runs/${RUN}/actions`)
          return [
            { action: 'jira.read', operationKind: null, credentialed: false, outcome: 'SUCCEEDED' },
            {
              action: 'repository.checkout',
              operationKind: 'git.checkout',
              credentialed: true,
              outcome: 'SUCCEEDED',
            },
            {
              action: 'dependencies.install',
              operationKind: 'dependencies.install',
              credentialed: false,
              outcome: 'SUCCEEDED',
            },
            {
              action: 'workspace.command',
              operationKind: 'command',
              credentialed: false,
              outcome: 'SUCCEEDED',
            },
            {
              action: 'qa.execute_playwright',
              operationKind: 'playwright.run',
              credentialed: false,
              outcome: 'FAILED',
            },
            {
              action: 'jira.issue.create',
              operationKind: null,
              credentialed: false,
              outcome: decisions['ap-2'] === 'APPROVED' ? 'SUCCEEDED' : 'DENIED',
            },
          ] as never;
        throw new Error(`Unexpected GET ${path}`);
      },
      async post(path: string, body: unknown) {
        calls.push(`${who} POST ${path}`);
        if (path === '/api/conversations') return { id: 'conv-1' } as never;
        if (path === '/api/qa/runs') {
          expect(body).toMatchObject({
            storyKey: 'SMOKE-1',
            targetUrl: 'https://qa.pilot.example/cart',
          });
          return { mode: 'GENERIC_RUNTIME', agentRun: { id: RUN } } as never;
        }
        const decision = /^\/api\/approvals\/(ap-\d)\/decision$/.exec(path);
        if (decision) {
          expect(who).toBe('admin');
          decisions[decision[1]!] = (body as { decision: string }).decision;
          return {} as never;
        }
        const retrieval = /\/artifacts\/(a-\w+)\/retrievals$/.exec(path);
        if (retrieval) return { path: `/content/${retrieval[1]}` } as never;
        throw new Error(`Unexpected POST ${path}`);
      },
      async bytes(path: string) {
        return Buffer.from(path.endsWith('a-trace') ? trace : report);
      },
    });
    return {
      calls,
      decisions,
      polls: () => polls,
      employee: session('employee'),
      admin: session('admin'),
    };
  }

  const run = (fake: ReturnType<typeof stack>, config: SmokeConfig = smokeConfig(env())) =>
    runSmoke(config, {
      employee: fake.employee,
      admin: fake.admin,
      sleep: async () => undefined,
      now: Date.now,
      commit: 'abc123',
      environment: 'pilot',
      secrets: [EMPLOYEE_PASSWORD, ADMIN_PASSWORD],
    });

  it('proves the whole path and the live proofs it reached, with no secret in the report', async () => {
    const fake = stack();
    const report = await run(fake);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.steps.map((step) => step.id)).toEqual([
      'sessions',
      'write-scope',
      'real-model',
      'run-started',
      'run-completed',
      'story-read',
      'private-checkout',
      'dependency-install',
      'sandboxed-test',
      'playwright-run',
      'draft-write',
      'evidence-stored',
      'evidence-retrieved',
    ]);
    expect(report).toMatchObject({
      passed: true,
      runId: RUN,
      proofs: {
        'sandbox-live': 'passed',
        'private-scm-live': 'passed',
        'real-model-live': 'passed',
        'object-store-live': 'passed',
        'vault-live': 'passed',
      },
      redactions: 0,
    });
    expect(fake.decisions).toEqual({ 'ap-1': 'APPROVED', 'ap-2': 'APPROVED' });
    const printed = JSON.stringify(report) + summarizeSmoke(report);
    expect(printed).not.toContain(EMPLOYEE_PASSWORD);
    expect(printed).not.toContain(ADMIN_PASSWORD);
  });

  it('refuses a write outside the disposable resources and fails', async () => {
    const fake = stack({ writeTo: 'PROD' });
    const report = await run(fake);
    expect(fake.decisions).toEqual({ 'ap-1': 'APPROVED', 'ap-2': 'REJECTED' });
    expect(report.passed).toBe(false);
    expect(report.steps.find((step) => step.id === 'run-completed')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('jira.issue.create on issue-tracker.project'),
    });
    expect(report.steps.find((step) => step.id === 'draft-write')!.status).toBe('failed');
  });

  it('starts nothing when the organization could write beyond the disposable resources', async () => {
    const fake = stack({
      connections: [
        {
          id: 'jira-1',
          provider: 'jira',
          status: 'ACTIVE',
          settings: { allowedProjects: ['SMOKE', 'PROD'] },
        },
      ],
    });
    const report = await run(fake);
    expect(report.passed).toBe(false);
    expect(report.steps.map((step) => [step.id, step.status])).toEqual([
      ['sessions', 'passed'],
      ['write-scope', 'failed'],
    ]);
    expect(fake.calls.some((call) => call.includes('/api/qa/runs'))).toBe(false);
    expect(Object.values(report.proofs).every((proof) => proof !== 'passed')).toBe(true);
  });
});

describe('pilot smoke workflow', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'pilot-smoke.yml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const section = (start: RegExp, end: RegExp) => {
    const from = workflow.search(start);
    const rest = workflow.slice(from);
    const body = rest.indexOf('\n') + 1;
    const length = rest.slice(body).search(end);
    return length < 0 ? rest : rest.slice(0, body + length);
  };

  it('starts only by hand, never on a push or a pull request', () => {
    const triggers = section(/^on:$/m, /^\S/m);
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    expect([...triggers.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])).toEqual([
      'workflow_dispatch',
    ]);
    expect(workflow).toContain(
      "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(workflow).toMatch(/^ {4}environment: pilot$/m);
  });

  it('uses only contexts GitHub allows in job-level env, so the file parses', () => {
    const jobEnv = section(/^ {4}env:$/m, /^ {4}\S/m);
    const contexts = [...jobEnv.matchAll(/\$\{\{\s*(\w+)/g)].map((match) => match[1]);
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts)
      expect(['github', 'vars', 'inputs', 'secrets']).toContain(context);
  });
});
