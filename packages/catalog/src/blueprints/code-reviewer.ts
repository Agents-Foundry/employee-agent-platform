import type { AgentBlueprintVersionDefinition } from '../../../contracts/src/catalog.js';

/**
 * Code Reviewer 1.0.0: a least-privilege role. It reads work items and repositories and runs
 * the project's checks in the sandbox, then reports findings. It has no file-editing or
 * source-control write tools and may not request writes, so its review can never change the
 * code it reviews. Declarative data only (ADR 0009).
 */
export const codeReviewer: AgentBlueprintVersionDefinition = {
  id: 'engineering.code-reviewer',
  version: '1.0.0',
  title: 'Code Reviewer',
  department: 'Engineering',
  role: 'code-reviewer',
  mission:
    'Review proposed changes against their work items, run the project checks in an isolated ' +
    'workspace, and report defects, risks and missing tests to a human reviewer.',
  persona: { profile: 'code-reviewer-default' },
  runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
  model: { profile: 'review-default' },
  skills: [
    { id: 'change-scoping', version: '1.1.0' },
    { id: 'code-review', version: '1.0.0' },
    { id: 'review-reporting', version: '1.0.0' },
  ],
  tools: [
    { id: 'repository', version: '1.0.0' },
    { id: 'build', version: '1.0.0' },
    { id: 'dependencies', version: '1.0.0' },
    { id: 'issue-tracker', version: '1.0.0' },
    { id: 'artifact', version: '1.0.0' },
  ],
  workflows: [{ id: 'review-change', version: '1.0.0' }],
  connectors: [
    {
      capability: 'issueTracker',
      capabilities: ['issueTracker.read'],
      selection: { questionId: 'issueTracker', providers: { Jira: 'jira' } },
    },
    {
      capability: 'sourceControl',
      capabilities: ['sourceControl.read'],
      selection: { questionId: 'sourceControl', providers: { GitHub: 'github' } },
    },
  ],
  mcp: [],
  memory: { profile: 'project-employee-memory' },
  knowledge: { sources: ['assigned-repositories', 'issue-tracker-project'] },
  policy: {
    profile: 'review-read-only',
    actions: [
      'repository.read',
      'workspace.dependencies.install',
      'workspace.command',
      'jira.read',
    ],
  },
  evaluations: { suite: 'code-reviewer-v1' },
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
