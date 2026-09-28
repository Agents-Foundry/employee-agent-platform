import type { WorkflowDefinition } from '../../contracts/src/catalog.js';

export const workflows: WorkflowDefinition[] = [
  {
    id: 'implement-ui-change',
    version: '1.0.0',
    title: 'Implement UI change',
    description:
      'Implement one work item in the workspace, verify it with the project scripts and propose it as a draft pull request.',
    steps: [
      { id: 'analyze', title: 'Scope the change', skill: 'change-scoping', action: 'jira.read' },
      {
        id: 'implement',
        title: 'Implement the change',
        skill: 'frontend-implementation',
        action: 'repository.write',
      },
      {
        id: 'verify',
        title: 'Run lint, tests and build',
        skill: 'frontend-verification',
        action: 'workspace.command',
      },
      {
        id: 'propose',
        title: 'Open a draft pull request',
        skill: 'change-proposal',
        action: 'repository.pull_request.create',
      },
    ],
  },
  {
    id: 'implement-ui-change',
    version: '1.1.0',
    title: 'Implement UI change',
    description:
      'Implement one work item in the workspace, install its locked dependencies, verify it with the project scripts and propose it as a draft pull request.',
    steps: [
      { id: 'analyze', title: 'Scope the change', skill: 'change-scoping', action: 'jira.read' },
      {
        id: 'implement',
        title: 'Implement the change',
        skill: 'frontend-implementation',
        action: 'repository.write',
      },
      {
        id: 'install',
        title: 'Install locked dependencies',
        skill: 'frontend-verification',
        action: 'workspace.dependencies.install',
      },
      {
        id: 'verify',
        title: 'Run lint, tests and build',
        skill: 'frontend-verification',
        action: 'workspace.command',
      },
      {
        id: 'propose',
        title: 'Open a draft pull request',
        skill: 'change-proposal',
        action: 'repository.pull_request.create',
      },
    ],
  },
  {
    id: 'validate-story',
    version: '1.0.0',
    title: 'Validate story',
    description: 'Validate one work item end to end, from acceptance criteria to defect drafts.',
    steps: [
      { id: 'analyze', title: 'Analyze story', skill: 'story-analysis', action: 'jira.read' },
      { id: 'plan', title: 'Plan tests', skill: 'risk-based-test-planning', action: 'qa.plan' },
      {
        id: 'execute',
        title: 'Run browser checks',
        skill: 'regression-analysis',
        action: 'qa.execute_playwright',
      },
      {
        id: 'report',
        title: 'Draft defects',
        skill: 'defect-reporting',
        action: 'jira.issue.create',
      },
    ],
  },
  {
    id: 'sanity-test',
    version: '1.0.0',
    title: 'Sanity test',
    description: 'Run a short smoke pack against an environment.',
    steps: [
      {
        id: 'plan',
        title: 'Select smoke pack',
        skill: 'risk-based-test-planning',
        action: 'qa.plan',
      },
      {
        id: 'execute',
        title: 'Run smoke checks',
        skill: 'regression-analysis',
        action: 'qa.execute_playwright',
      },
    ],
  },
  {
    id: 'regression-test',
    version: '1.0.0',
    title: 'Regression test',
    description: 'Plan and run regression coverage for a change set.',
    steps: [
      { id: 'analyze', title: 'Analyze change', skill: 'story-analysis', action: 'jira.read' },
      {
        id: 'plan',
        title: 'Plan regression',
        skill: 'risk-based-test-planning',
        action: 'qa.plan',
      },
      {
        id: 'execute',
        title: 'Run regression',
        skill: 'regression-analysis',
        action: 'qa.execute_playwright',
      },
      {
        id: 'report',
        title: 'Draft defects',
        skill: 'defect-reporting',
        action: 'jira.issue.create',
      },
    ],
  },
  {
    id: 'post-release-validation',
    version: '1.0.0',
    title: 'Post-release validation',
    description: 'Verify a release in its target environment and report regressions.',
    steps: [
      {
        id: 'analyze',
        title: 'Review release scope',
        skill: 'story-analysis',
        action: 'jira.read',
      },
      {
        id: 'execute',
        title: 'Run release checks',
        skill: 'regression-analysis',
        action: 'qa.execute_playwright',
      },
      {
        id: 'report',
        title: 'Draft defects',
        skill: 'defect-reporting',
        action: 'jira.issue.create',
      },
    ],
  },
];
