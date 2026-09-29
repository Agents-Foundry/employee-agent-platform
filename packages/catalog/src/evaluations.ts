import type {
  EvaluationStep,
  EvaluationSuiteDefinition,
  EvaluationWorld,
} from '../../contracts/src/catalog.js';

// Governance evaluation suites (ADR 0019). A scripted model drives each role through the real
// control plane, agent runtime and execution runtime; every tool result, approval and the
// final run are checked. They evaluate governance and role wiring, not model quality.

const storefront = 'https://github.com/acme/storefront';
const qaUrl = 'https://qa.acme-shop.com';
const registry = 'https://npm.acme-shop.com/';
const packageJson = JSON.stringify({
  name: 'storefront',
  private: true,
  scripts: { lint: 'eslint .', test: 'vitest run', typecheck: 'tsc --noEmit' },
});

const world = (issues: EvaluationWorld['issues']): EvaluationWorld => ({
  issueProjects: [...new Set(issues.map((issue) => issue.key.split('-')[0]!))],
  issues,
  repositories: ['acme/storefront'],
  repositoryFiles: { 'package.json': packageJson, 'package-lock.json': '{"lockfileVersion":3}' },
});

const tracker = { issueTracker: ['Jira'], sourceControl: ['GitHub'] };

// Steps shared by several roles.
const readIssue = (key: string): EvaluationStep => ({
  tool: 'issue-tracker',
  input: { issueKey: key },
  expect: { outcome: 'SUCCEEDED', contains: `Work item ${key}` },
});
const checkout = (ref = 'main'): EvaluationStep => ({
  tool: 'repository',
  input: { kind: 'git.checkout', repositoryUrl: storefront, ref, path: 'repo' },
  expect: { outcome: 'SUCCEEDED' },
});
const checkoutElsewhere: EvaluationStep = {
  tool: 'repository',
  input: {
    kind: 'git.checkout',
    repositoryUrl: 'https://github.com/acme/payments',
    ref: 'main',
    path: 'other',
  },
  expect: { outcome: 'FAILED', code: 'ACTION_DENIED' },
};
const write = (path: string, content: string): EvaluationStep => ({
  tool: 'code-editor',
  input: { kind: 'file.write', path, content },
  expect: { outcome: 'SUCCEEDED' },
});
const script = (name: string, allowed: boolean): EvaluationStep => ({
  tool: 'build',
  input: { kind: 'command', command: 'npm', args: ['run', name], cwd: 'repo' },
  expect: allowed ? { outcome: 'SUCCEEDED' } : { outcome: 'FAILED', code: 'ACTION_DENIED' },
});
const install = (registryUrl: string, allowed: boolean): EvaluationStep => ({
  tool: 'dependencies',
  input: { kind: 'dependencies.install', path: 'repo', registryUrl },
  expect: allowed ? { outcome: 'SUCCEEDED' } : { outcome: 'FAILED', code: 'ACTION_DENIED' },
});
const browser = (baseUrl: string, expectation: EvaluationStep['expect']): EvaluationStep => ({
  tool: 'browser',
  input: { kind: 'playwright.run', project: 'chromium', baseUrl, path: 'repo' },
  expect: expectation,
});
const propose = (
  decision: 'APPROVED' | 'REJECTED',
  repository = 'acme/storefront',
): EvaluationStep => ({
  tool: 'source-control',
  input: {
    repository,
    baseBranch: 'main',
    headBranch: 'agents-foundry/change',
    title: 'Proposed change',
    body: 'Verified with the project scripts.',
    path: 'repo',
  },
  expect: {
    outcome: 'SUCCEEDED',
    contains: 'Opened draft pull request',
    approval: { action: 'repository.pull_request.create', decision },
  },
});
const report = (type: 'report' | 'test_report'): EvaluationStep => ({
  tool: 'artifact',
  input: {
    name: 'evaluation-report.md',
    type,
    mediaType: 'text/markdown',
    content: '# Findings\n\nNo blocking issues.',
  },
  expect: { outcome: 'SUCCEEDED', contains: 'Stored' },
});
const notAvailable = (tool: string, input: Record<string, unknown>): EvaluationStep => ({
  tool,
  input,
  expect: { outcome: 'NOT_AVAILABLE' },
});
const editAttempt = notAvailable('code-editor', {
  kind: 'file.write',
  path: 'repo/README.md',
  content: 'changed',
});
const proposeAttempt = notAvailable('source-control', {
  repository: 'acme/storefront',
  baseBranch: 'main',
  headBranch: 'agents-foundry/change',
  title: 'Not allowed',
  body: '',
  path: 'repo',
});

export const evaluationSuites: EvaluationSuiteDefinition[] = [
  {
    id: 'qa-engineer-v1',
    blueprintId: 'engineering.qa-engineer',
    title: 'QA Engineer governance',
    world: world([
      {
        key: 'QA-12',
        type: 'Story',
        summary: 'Checkout shows the free-shipping banner',
        description: 'Orders over $50 show "Free shipping" on the checkout page.',
      },
    ]),
    scenarios: [
      {
        id: 'validate-story',
        title: 'Validates a story: reads it, runs approved browser checks in scope, reports',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          qaUrl,
          ...tracker,
          testingTechnologies: ['Playwright'],
        },
        task: { objective: 'Validate QA-12', workflow: 'validate-story', workItemKey: 'QA-12' },
        steps: [
          readIssue('QA-12'),
          checkout(),
          browser(`${qaUrl}/checkout`, {
            outcome: 'SUCCEEDED',
            approval: { action: 'qa.execute_playwright', decision: 'APPROVED' },
          }),
          browser('https://www.acme-shop.com/checkout', {
            outcome: 'FAILED',
            code: 'ACTION_DENIED',
          }),
          editAttempt,
          report('test_report'),
        ],
        expect: {
          offeredTools: ['artifact', 'browser', 'issue-tracker', 'repository'],
          runStatus: 'COMPLETED',
          executedActions: ['jira.read'],
        },
      },
      {
        id: 'rejected-browser-run',
        title: 'A rejected browser run cancels the run and executes nothing',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          qaUrl,
          ...tracker,
          testingTechnologies: ['Playwright'],
        },
        task: { objective: 'Validate QA-12', workflow: 'sanity-test' },
        steps: [
          browser(`${qaUrl}/checkout`, {
            outcome: 'SUCCEEDED',
            approval: { action: 'qa.execute_playwright', decision: 'REJECTED' },
          }),
        ],
        expect: {
          offeredTools: ['artifact', 'browser', 'issue-tracker', 'repository'],
          runStatus: 'CANCELLED',
          executedActions: [],
        },
      },
      {
        id: 'file-defect',
        title: 'Files a defect only after approval (1.2.0 has the issue-tracker write capability)',
        blueprintVersions: ['1.2.0'],
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          qaUrl,
          ...tracker,
          testingTechnologies: ['Playwright'],
        },
        task: { objective: 'Report QA-12 defects', workflow: 'validate-story' },
        steps: [
          {
            tool: 'issue-tracker',
            input: {
              projectKey: 'QA',
              summary: 'Banner missing for $60 orders',
              description: 'Expected "Free shipping"; the banner is absent.',
              issueType: 'Bug',
            },
            expect: {
              outcome: 'SUCCEEDED',
              contains: 'Created QA-',
              approval: { action: 'jira.issue.create', decision: 'APPROVED' },
            },
          },
          {
            tool: 'issue-tracker',
            input: {
              projectKey: 'OPS',
              summary: 'Outside the configured projects',
              description: 'Must be refused.',
              issueType: 'Task',
            },
            expect: { outcome: 'FAILED', code: 'ACTION_DENIED' },
          },
        ],
        expect: {
          offeredTools: ['artifact', 'browser', 'issue-tracker', 'repository'],
          runStatus: 'COMPLETED',
          executedActions: ['jira.issue.create'],
        },
      },
      {
        id: 'no-defect-filing-without-write-capability',
        title: 'Version 1.1.0 cannot file issues: its manifest lacks the write capability',
        blueprintVersions: ['1.1.0'],
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          qaUrl,
          ...tracker,
          testingTechnologies: ['Playwright'],
        },
        task: { objective: 'Report QA-12 defects', workflow: 'validate-story' },
        steps: [
          {
            tool: 'issue-tracker',
            input: {
              projectKey: 'QA',
              summary: 'Banner missing for $60 orders',
              description: 'Expected "Free shipping"; the banner is absent.',
              issueType: 'Bug',
            },
            expect: { outcome: 'FAILED', code: 'ACTION_DENIED' },
          },
        ],
        expect: {
          offeredTools: ['artifact', 'browser', 'issue-tracker', 'repository'],
          runStatus: 'COMPLETED',
          executedActions: [],
        },
      },
    ],
  },
  {
    id: 'frontend-engineer-v1',
    blueprintId: 'engineering.frontend-engineer',
    title: 'Frontend Engineer governance',
    world: world([
      {
        key: 'UI-7',
        type: 'Story',
        summary: 'Show a free-shipping banner',
        description: 'Banner text: Free shipping over $50',
      },
    ]),
    scenarios: [
      {
        id: 'implement-and-propose',
        title: 'Implements, verifies with allowed scripts only, and proposes after approval',
        blueprintVersions: ['1.0.0'],
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          projectScripts: 'lint, test',
          ...tracker,
        },
        task: { objective: 'Implement UI-7', workflow: 'implement-ui-change', workItemKey: 'UI-7' },
        steps: [
          readIssue('UI-7'),
          checkout(),
          write('repo/src/banner.js', "module.exports = () => 'Free shipping over $50';\n"),
          script('test', true),
          script('deploy', false),
          notAvailable('browser', { kind: 'playwright.run', project: 'x', baseUrl: qaUrl }),
          propose('APPROVED'),
        ],
        expect: {
          offeredTools: [
            'artifact',
            'build',
            'code-editor',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'COMPLETED',
          executedActions: ['jira.read', 'repository.pull_request.create'],
        },
      },
      {
        id: 'install-from-configured-registry',
        title: 'Installs only from the configured registry, then proposes after approval',
        blueprintVersions: ['1.1.0'],
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          projectScripts: 'lint, test',
          packageRegistryUrl: registry,
          ...tracker,
        },
        task: { objective: 'Implement UI-7', workflow: 'implement-ui-change', workItemKey: 'UI-7' },
        steps: [
          checkout(),
          write('repo/src/banner.js', "module.exports = () => 'Free shipping over $50';\n"),
          install(registry, true),
          install('https://registry.npmjs.org/', false),
          script('lint', true),
          propose('APPROVED'),
        ],
        expect: {
          offeredTools: [
            'artifact',
            'build',
            'code-editor',
            'dependencies',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'COMPLETED',
          executedActions: ['repository.pull_request.create'],
        },
      },
      {
        id: 'proposal-outside-scope-or-rejected',
        title: 'A pull request outside the configured repository is denied; a rejected one cancels',
        blueprintVersions: ['1.0.0'],
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          ...tracker,
        },
        task: { objective: 'Implement UI-7', workflow: 'implement-ui-change' },
        steps: [
          checkout(),
          checkoutElsewhere,
          write('repo/src/banner.js', "module.exports = () => 'Free shipping';\n"),
          {
            ...propose('APPROVED', 'acme/payments'),
            expect: { outcome: 'FAILED', code: 'ACTION_DENIED' },
          },
          propose('REJECTED'),
        ],
        expect: {
          offeredTools: [
            'artifact',
            'build',
            'code-editor',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'CANCELLED',
          executedActions: [],
        },
      },
    ],
  },
  {
    id: 'backend-engineer-v1',
    blueprintId: 'engineering.backend-engineer',
    title: 'Backend Engineer governance',
    world: world([
      {
        key: 'API-31',
        type: 'Task',
        summary: 'Add an order total endpoint',
        description: 'GET /orders/:id/total returns the total in cents.',
      },
    ]),
    scenarios: [
      {
        id: 'implement-and-propose',
        title: 'Implements, installs from the configured registry, verifies and proposes',
        answers: {
          projectName: 'Orders',
          repositoryUrl: storefront,
          projectScripts: 'lint, typecheck, test',
          packageRegistryUrl: registry,
          ...tracker,
        },
        task: {
          objective: 'Implement API-31',
          workflow: 'implement-api-change',
          workItemKey: 'API-31',
        },
        steps: [
          readIssue('API-31'),
          checkout(),
          write(
            'repo/src/order-total.ts',
            'export const orderTotal = (items: { cents: number }[]) =>\n  items.reduce((sum, item) => sum + item.cents, 0);\n',
          ),
          install(registry, true),
          install('https://registry.npmjs.org/', false),
          script('typecheck', true),
          script('test', true),
          script('migrate:production', false),
          notAvailable('browser', { kind: 'playwright.run', project: 'x', baseUrl: qaUrl }),
          propose('APPROVED'),
        ],
        expect: {
          offeredTools: [
            'artifact',
            'build',
            'code-editor',
            'dependencies',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'COMPLETED',
          executedActions: ['jira.read', 'repository.pull_request.create'],
        },
      },
      {
        id: 'no-registry-no-install',
        title: 'Without a configured registry every install is refused',
        answers: { projectName: 'Orders', repositoryUrl: storefront, ...tracker },
        task: { objective: 'Implement API-31', workflow: 'implement-api-change' },
        steps: [checkout(), install(registry, false), checkoutElsewhere],
        expect: {
          offeredTools: [
            'artifact',
            'build',
            'code-editor',
            'dependencies',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'COMPLETED',
          executedActions: [],
        },
      },
    ],
  },
  {
    id: 'code-reviewer-v1',
    blueprintId: 'engineering.code-reviewer',
    title: 'Code Reviewer governance',
    world: world([
      {
        key: 'UI-9',
        type: 'Story',
        summary: 'Review the checkout banner change',
        description: 'Check that the banner hides below $50.',
      },
    ]),
    scenarios: [
      {
        id: 'review-read-only',
        title: 'Reviews and reports, but can neither edit, propose nor file issues',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          projectScripts: 'lint, test',
          packageRegistryUrl: registry,
          ...tracker,
        },
        task: { objective: 'Review UI-9', workflow: 'review-change', workItemKey: 'UI-9' },
        steps: [
          readIssue('UI-9'),
          checkout('agents-foundry/ui-9'),
          install(registry, true),
          script('test', true),
          script('deploy', false),
          editAttempt,
          proposeAttempt,
          {
            tool: 'issue-tracker',
            input: {
              projectKey: 'UI',
              summary: 'Reviewer may not file issues',
              description: 'Must be refused.',
              issueType: 'Bug',
            },
            expect: { outcome: 'FAILED', code: 'ACTION_DENIED' },
          },
          report('report'),
        ],
        expect: {
          offeredTools: ['artifact', 'build', 'dependencies', 'issue-tracker', 'repository'],
          runStatus: 'COMPLETED',
          executedActions: ['jira.read'],
        },
      },
    ],
  },
  {
    id: 'test-automation-engineer-v1',
    blueprintId: 'engineering.test-automation-engineer',
    title: 'Test Automation Engineer governance',
    world: world([
      {
        key: 'QA-20',
        type: 'Story',
        summary: 'Automate the checkout banner check',
        description: 'Orders over $50 show "Free shipping".',
      },
    ]),
    scenarios: [
      {
        id: 'automate-run-and-propose',
        title: 'Writes tests, runs them in QA after approval, and proposes them after approval',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: storefront,
          qaUrl,
          packageRegistryUrl: registry,
          ...tracker,
        },
        task: {
          objective: 'Automate QA-20',
          workflow: 'automate-regression-tests',
          workItemKey: 'QA-20',
        },
        steps: [
          readIssue('QA-20'),
          checkout(),
          write(
            'repo/tests/checkout-banner.spec.ts',
            "import { test, expect } from '@playwright/test';\ntest('banner', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByText('Free shipping')).toBeVisible();\n});\n",
          ),
          install(registry, true),
          browser(`${qaUrl}/checkout`, {
            outcome: 'SUCCEEDED',
            approval: { action: 'qa.execute_playwright', decision: 'APPROVED' },
          }),
          browser('https://www.acme-shop.com/checkout', {
            outcome: 'FAILED',
            code: 'ACTION_DENIED',
          }),
          notAvailable('build', {
            kind: 'command',
            command: 'npm',
            args: ['run', 'test'],
            cwd: 'repo',
          }),
          propose('APPROVED'),
        ],
        expect: {
          offeredTools: [
            'artifact',
            'browser',
            'code-editor',
            'dependencies',
            'issue-tracker',
            'repository',
            'source-control',
          ],
          runStatus: 'COMPLETED',
          executedActions: ['jira.read', 'repository.pull_request.create'],
        },
      },
    ],
  },
];
