import type { AgentBlueprintVersionDefinition } from '../../../contracts/src/catalog.js';

/**
 * Frontend Engineer 1.0.0 (Phase G): the architectural acceptance test for ADR 0009. It is
 * declarative data only and runs on the same agent runtime, control plane and execution
 * runtime as the QA Engineer, with no role-specific platform code. Change it only by adding a
 * new version.
 */
export const frontendEngineer: AgentBlueprintVersionDefinition = {
  id: 'engineering.frontend-engineer',
  version: '1.0.0',
  title: 'Frontend Engineer',
  department: 'Engineering',
  role: 'frontend-engineer',
  mission:
    'Implement approved frontend changes in an isolated workspace, verify them with the ' +
    "project's own scripts, and propose them as draft pull requests for human review.",
  persona: { profile: 'frontend-engineer-default' },
  runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
  model: { profile: 'frontend-default' },
  skills: [
    { id: 'change-scoping', version: '1.0.0' },
    { id: 'frontend-implementation', version: '1.0.0' },
    { id: 'frontend-verification', version: '1.0.0' },
    { id: 'change-proposal', version: '1.0.0' },
  ],
  tools: [
    { id: 'repository', version: '1.0.0' },
    { id: 'code-editor', version: '1.0.0' },
    { id: 'build', version: '1.0.0' },
    { id: 'source-control', version: '1.0.0' },
    { id: 'issue-tracker', version: '1.0.0' },
    { id: 'artifact', version: '1.0.0' },
  ],
  workflows: [{ id: 'implement-ui-change', version: '1.0.0' }],
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
    profile: 'frontend-standard',
    actions: [
      'repository.read',
      'repository.write',
      'workspace.command',
      'jira.read',
      'repository.pull_request.create',
      'production.deploy',
    ],
  },
  evaluations: { suite: 'frontend-engineer-v1' },
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

/**
 * Frontend Engineer 1.1.0: installs the project's locked dependencies from the registry the
 * admin configures (`packageRegistryUrl`) before verifying. Without a configured registry,
 * installs are refused as out of scope.
 */
export const frontendEngineerV1_1: AgentBlueprintVersionDefinition = {
  ...frontendEngineer,
  version: '1.1.0',
  skills: frontendEngineer.skills.map((skill) =>
    skill.id === 'frontend-verification' ? { ...skill, version: '1.1.0' } : skill,
  ),
  tools: [
    ...frontendEngineer.tools.slice(0, 3),
    { id: 'dependencies', version: '1.0.0' },
    ...frontendEngineer.tools.slice(3),
  ],
  workflows: [{ id: 'implement-ui-change', version: '1.1.0' }],
  policy: {
    ...frontendEngineer.policy,
    actions: [...frontendEngineer.policy.actions, 'workspace.dependencies.install'],
  },
  questionnaire: [
    ...frontendEngineer.questionnaire.slice(0, 3),
    {
      id: 'packageRegistryUrl',
      label: 'npm registry or mirror URL (HTTPS)',
      type: 'url',
      required: false,
      scope: 'AGENT',
    },
    ...frontendEngineer.questionnaire.slice(3),
  ],
};
