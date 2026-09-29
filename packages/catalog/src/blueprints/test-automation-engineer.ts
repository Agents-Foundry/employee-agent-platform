import type { AgentBlueprintVersionDefinition } from '../../../contracts/src/catalog.js';

/**
 * Test Automation Engineer 1.0.0: turns work items into Playwright regression tests, runs them
 * against the configured QA environment (each browser run needs approval), and proposes them
 * as draft pull requests. It combines the QA and Frontend capabilities with no new platform
 * code. Declarative data only (ADR 0009).
 */
export const testAutomationEngineer: AgentBlueprintVersionDefinition = {
  id: 'engineering.test-automation-engineer',
  version: '1.0.0',
  title: 'Test Automation Engineer',
  department: 'Engineering',
  role: 'test-automation-engineer',
  mission:
    'Write Playwright regression tests for approved work items, run them against the QA ' +
    'environment only with approval, and propose them as draft pull requests.',
  persona: { profile: 'test-automation-default' },
  runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
  model: { profile: 'qa-default' },
  skills: [
    { id: 'change-scoping', version: '1.1.0' },
    { id: 'test-authoring', version: '1.0.0' },
    { id: 'test-verification', version: '1.0.0' },
    { id: 'change-proposal', version: '1.1.0' },
  ],
  tools: [
    { id: 'repository', version: '1.0.0' },
    { id: 'code-editor', version: '1.0.0' },
    { id: 'dependencies', version: '1.0.0' },
    { id: 'browser', version: '1.0.0' },
    { id: 'source-control', version: '1.0.0' },
    { id: 'issue-tracker', version: '1.0.0' },
    { id: 'artifact', version: '1.0.0' },
  ],
  workflows: [{ id: 'automate-regression-tests', version: '1.0.0' }],
  connectors: [
    {
      capability: 'issueTracker',
      capabilities: ['issueTracker.read'],
      selection: { questionId: 'issueTracker', providers: { Jira: 'jira' } },
    },
    {
      capability: 'sourceControl',
      capabilities: ['sourceControl.read', 'sourceControl.write'],
      selection: { questionId: 'sourceControl', providers: { GitHub: 'github' } },
    },
  ],
  mcp: [],
  memory: { profile: 'project-employee-memory' },
  knowledge: { sources: ['assigned-repositories', 'issue-tracker-project'] },
  policy: {
    profile: 'test-automation-standard',
    actions: [
      'repository.read',
      'repository.write',
      'workspace.dependencies.install',
      'qa.execute_playwright',
      'jira.read',
      'repository.pull_request.create',
      'production.deploy',
    ],
  },
  evaluations: { suite: 'test-automation-engineer-v1' },
  questionnaire: [
    { id: 'projectName', label: 'Project name', type: 'text', required: true, scope: 'AGENT' },
    { id: 'repositoryUrl', label: 'Repository URL', type: 'url', required: true, scope: 'AGENT' },
    { id: 'qaUrl', label: 'QA environment URL', type: 'url', required: true, scope: 'AGENT' },
    {
      id: 'packageRegistryUrl',
      label: 'npm registry or mirror URL (HTTPS)',
      type: 'url',
      required: false,
      scope: 'AGENT',
    },
    {
      id: 'issueTracker',
      label: 'Issue tracker',
      type: 'multiselect',
      required: true,
      scope: 'INSTALLATION',
      options: ['Jira'],
    },
    {
      id: 'sourceControl',
      label: 'Source control',
      type: 'multiselect',
      required: true,
      scope: 'INSTALLATION',
      options: ['GitHub'],
    },
  ],
};
