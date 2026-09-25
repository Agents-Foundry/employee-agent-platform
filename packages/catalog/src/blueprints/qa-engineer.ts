import type { AgentBlueprintVersionDefinition } from '../../../contracts/src/catalog.js';

/**
 * QA Engineer 1.1.0. Content is pinned by digest once registered: change it only by adding
 * a new version, never by editing this one (startup fails closed on a mutated version).
 */
export const qaEngineer: AgentBlueprintVersionDefinition = {
  id: 'engineering.qa-engineer',
  version: '1.1.0',
  title: 'QA Engineer',
  department: 'Engineering',
  role: 'qa-engineer',
  mission:
    'Plan quality checks, collect evidence, and request approval before browser execution or external writes.',
  persona: { profile: 'qa-engineer-default' },
  runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
  model: { profile: 'qa-default' },
  skills: [
    { id: 'story-analysis', version: '1.0.0' },
    { id: 'risk-based-test-planning', version: '1.0.0' },
    { id: 'regression-analysis', version: '1.0.0' },
    { id: 'defect-reporting', version: '1.0.0' },
  ],
  tools: [
    { id: 'repository', version: '1.0.0' },
    { id: 'issue-tracker', version: '1.0.0' },
    { id: 'browser', version: '1.0.0' },
    { id: 'artifact', version: '1.0.0' },
  ],
  workflows: [
    { id: 'validate-story', version: '1.0.0' },
    { id: 'sanity-test', version: '1.0.0' },
    { id: 'regression-test', version: '1.0.0' },
    { id: 'post-release-validation', version: '1.0.0' },
  ],
  connectors: [
    {
      capability: 'issueTracker',
      capabilities: ['issueTracker.read'],
      selection: {
        questionId: 'issueTracker',
        providers: { Jira: 'jira', 'Azure DevOps': 'azure-devops', Linear: 'linear' },
      },
    },
    {
      capability: 'sourceControl',
      capabilities: ['sourceControl.read'],
      selection: {
        questionId: 'sourceControl',
        providers: { Bitbucket: 'bitbucket', GitHub: 'github', GitLab: 'gitlab' },
      },
    },
  ],
  mcp: [
    { id: 'playwright', whenAnswer: { questionId: 'testingTechnologies', includes: 'Playwright' } },
  ],
  memory: { profile: 'project-employee-memory' },
  knowledge: { sources: ['assigned-repositories', 'issue-tracker-project'] },
  policy: {
    profile: 'qa-standard',
    actions: [
      'repository.read',
      'jira.read',
      'qa.plan',
      'qa.execute_playwright',
      'jira.issue.create',
      'repository.pull_request.create',
      'production.deploy',
    ],
  },
  evaluations: { suite: 'qa-engineer-v1' },
  questionnaire: [
    { id: 'projectName', label: 'Project name', type: 'text', required: true, scope: 'AGENT' },
    { id: 'repositoryUrl', label: 'Repository URL', type: 'url', required: true, scope: 'AGENT' },
    { id: 'qaUrl', label: 'QA environment URL', type: 'url', required: true, scope: 'AGENT' },
    {
      id: 'issueTracker',
      label: 'Issue tracker',
      type: 'multiselect',
      required: true,
      scope: 'INSTALLATION',
      options: ['Jira', 'Azure DevOps', 'Linear'],
    },
    {
      id: 'sourceControl',
      label: 'Source control',
      type: 'multiselect',
      required: true,
      scope: 'INSTALLATION',
      options: ['Bitbucket', 'GitHub', 'GitLab'],
    },
    {
      id: 'testingTechnologies',
      label: 'Testing technologies',
      type: 'multiselect',
      required: true,
      scope: 'INSTALLATION',
      options: ['Playwright', 'Cypress', 'Selenium', 'REST APIs'],
    },
  ],
};

/**
 * QA Engineer 1.2.0 (Phase D). Adds `issueTracker.write`, so approved defect reports can be
 * filed through the Action Gateway. Everything else is inherited from 1.1.0 unchanged;
 * agents and installations on 1.1.0 keep that version.
 */
export const qaEngineerV1_2: AgentBlueprintVersionDefinition = {
  ...qaEngineer,
  version: '1.2.0',
  mission:
    'Plan quality checks, collect evidence, and file defects only through approved, governed issue-tracker writes.',
  connectors: qaEngineer.connectors.map((requirement) =>
    requirement.capability === 'issueTracker'
      ? { ...requirement, capabilities: ['issueTracker.read', 'issueTracker.write'] }
      : requirement,
  ),
};
