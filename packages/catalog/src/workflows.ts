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
    id: 'implement-api-change',
    version: '1.0.0',
    title: 'Implement API change',
    description:
      'Implement one backend work item in the workspace, install its locked dependencies, verify it with the project scripts and propose it as a draft pull request.',
    steps: [
      { id: 'analyze', title: 'Scope the change', skill: 'change-scoping', action: 'jira.read' },
      {
        id: 'implement',
        title: 'Implement the change',
        skill: 'backend-implementation',
        action: 'repository.write',
      },
      {
        id: 'install',
        title: 'Install locked dependencies',
        skill: 'backend-verification',
        action: 'workspace.dependencies.install',
      },
      {
        id: 'verify',
        title: 'Run lint, type-check and tests',
        skill: 'backend-verification',
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
    id: 'review-change',
    version: '1.0.0',
    title: 'Review change',
    description:
      'Review a proposed change against its work item: read it, run the project checks, and report findings without changing anything.',
    steps: [
      { id: 'analyze', title: 'Read the work item', skill: 'change-scoping', action: 'jira.read' },
      {
        id: 'inspect',
        title: 'Check out and read the change',
        skill: 'code-review',
        action: 'repository.read',
      },
      {
        id: 'install',
        title: 'Install locked dependencies',
        skill: 'code-review',
        action: 'workspace.dependencies.install',
      },
      {
        id: 'check',
        title: 'Run lint and tests',
        skill: 'code-review',
        action: 'workspace.command',
      },
      { id: 'report', title: 'Write the review report', skill: 'review-reporting' },
    ],
  },
  {
    id: 'automate-regression-tests',
    version: '1.0.0',
    title: 'Automate regression tests',
    description:
      'Turn a work item into Playwright regression tests, run them against the approved QA environment and propose them as a draft pull request.',
    steps: [
      {
        id: 'analyze',
        title: 'Read acceptance criteria',
        skill: 'change-scoping',
        action: 'jira.read',
      },
      {
        id: 'author',
        title: 'Write the tests',
        skill: 'test-authoring',
        action: 'repository.write',
      },
      {
        id: 'install',
        title: 'Install locked dependencies',
        skill: 'test-verification',
        action: 'workspace.dependencies.install',
      },
      {
        id: 'run',
        title: 'Run the tests against QA',
        skill: 'test-verification',
        action: 'qa.execute_playwright',
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
