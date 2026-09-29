import type { AgentBlueprintVersionDefinition } from '../../../contracts/src/catalog.js';

/**
 * Backend Engineer 1.0.0: implements approved service and API changes, verifies them with the
 * project's own scripts after installing locked dependencies, and proposes draft pull
 * requests. Declarative data only (ADR 0009); change it only by adding a new version.
 */
export const backendEngineer: AgentBlueprintVersionDefinition = {
  id: 'engineering.backend-engineer',
  version: '1.0.0',
  title: 'Backend Engineer',
  department: 'Engineering',
  role: 'backend-engineer',
  mission:
    'Implement approved backend and API changes in an isolated workspace, verify them with the ' +
    "project's own scripts, and propose them as draft pull requests for human review.",
  persona: { profile: 'backend-engineer-default' },
  runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
  model: { profile: 'backend-default' },
  skills: [
    { id: 'change-scoping', version: '1.1.0' },
    { id: 'backend-implementation', version: '1.0.0' },
    { id: 'backend-verification', version: '1.0.0' },
    { id: 'change-proposal', version: '1.1.0' },
  ],
  tools: [
    { id: 'repository', version: '1.0.0' },
    { id: 'code-editor', version: '1.0.0' },
    { id: 'build', version: '1.0.0' },
    { id: 'dependencies', version: '1.0.0' },
    { id: 'source-control', version: '1.0.0' },
    { id: 'issue-tracker', version: '1.0.0' },
    { id: 'artifact', version: '1.0.0' },
  ],
  workflows: [{ id: 'implement-api-change', version: '1.0.0' }],
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
    profile: 'backend-standard',
    actions: [
      'repository.read',
      'repository.write',
      'workspace.dependencies.install',
      'workspace.command',
      'jira.read',
      'repository.pull_request.create',
      'production.deploy',
    ],
  },
  evaluations: { suite: 'backend-engineer-v1' },
  questionnaire: [
    { id: 'projectName', label: 'Project name', type: 'text', required: true, scope: 'AGENT' },
    { id: 'repositoryUrl', label: 'Repository URL', type: 'url', required: true, scope: 'AGENT' },
    {
      id: 'projectScripts',
      label: 'npm scripts the agent may run (comma-separated)',
      type: 'text',
      required: false,
      scope: 'AGENT',
    },
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
