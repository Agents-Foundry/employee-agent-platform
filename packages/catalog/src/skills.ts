import type { SkillDefinition } from '../../contracts/src/catalog.js';

export const skills: SkillDefinition[] = [
  {
    id: 'story-analysis',
    version: '1.0.0',
    title: 'Story analysis',
    description:
      'Read a work item, its acceptance criteria and dependencies, and summarize quality risks.',
    requires: { tools: ['issue-tracker'], connectorCapabilities: ['issueTracker.read'] },
    activatesWhen: { workflows: ['validate-story', 'regression-test', 'post-release-validation'] },
  },
  {
    id: 'risk-based-test-planning',
    version: '1.0.0',
    title: 'Risk-based test planning',
    description: 'Derive prioritized smoke and regression scenarios from risk and change impact.',
    requires: { tools: ['repository'], connectorCapabilities: ['sourceControl.read'] },
    activatesWhen: {
      workflows: ['validate-story', 'sanity-test', 'regression-test', 'post-release-validation'],
    },
  },
  {
    id: 'regression-analysis',
    version: '1.0.0',
    title: 'Regression analysis',
    description: 'Execute approved browser checks and compare results with expected behaviour.',
    requires: { tools: ['browser', 'artifact'], connectorCapabilities: [] },
    activatesWhen: {
      workflows: ['validate-story', 'sanity-test', 'regression-test', 'post-release-validation'],
    },
  },
  {
    id: 'defect-reporting',
    version: '1.0.0',
    title: 'Defect reporting',
    description: 'Draft evidence-backed defects for human review before any publication.',
    requires: {
      tools: ['issue-tracker', 'artifact'],
      connectorCapabilities: ['issueTracker.read'],
    },
    activatesWhen: { workflows: ['validate-story', 'regression-test', 'post-release-validation'] },
  },
  {
    id: 'change-scoping',
    version: '1.0.0',
    title: 'Change scoping',
    description: 'Read a work item and locate the components, routes and tests it affects.',
    requires: {
      tools: ['issue-tracker', 'repository'],
      connectorCapabilities: ['issueTracker.read'],
    },
    activatesWhen: { workflows: ['implement-ui-change'] },
  },
  {
    id: 'frontend-implementation',
    version: '1.0.0',
    title: 'Frontend implementation',
    description: "Make focused UI changes that follow the repository's existing architecture.",
    requires: {
      tools: ['repository', 'code-editor'],
      connectorCapabilities: ['sourceControl.read'],
    },
    activatesWhen: { workflows: ['implement-ui-change'] },
  },
  {
    id: 'frontend-verification',
    version: '1.0.0',
    title: 'Frontend verification',
    description: "Run the project's lint, test and build scripts and fix what they report.",
    requires: { tools: ['build', 'artifact'], connectorCapabilities: [] },
    activatesWhen: { workflows: ['implement-ui-change'] },
  },
  {
    id: 'frontend-verification',
    version: '1.1.0',
    title: 'Frontend verification',
    description:
      "Install the project's locked dependencies, then run its lint, test and build scripts and fix what they report.",
    requires: { tools: ['dependencies', 'build', 'artifact'], connectorCapabilities: [] },
    activatesWhen: { workflows: ['implement-ui-change'] },
  },
  {
    id: 'change-proposal',
    version: '1.0.0',
    title: 'Change proposal',
    description: 'Describe verified changes and propose them as a draft pull request for review.',
    requires: { tools: ['source-control'], connectorCapabilities: ['sourceControl.write'] },
    activatesWhen: { workflows: ['implement-ui-change'] },
  },
  // Shared engineering skills, versioned for the roles added after Phase G. Released versions
  // above stay unchanged because Frontend Engineer bundles pin them.
  {
    id: 'change-scoping',
    version: '1.1.0',
    title: 'Change scoping',
    description: 'Read a work item and locate the components, routes and tests it affects.',
    requires: {
      tools: ['issue-tracker', 'repository'],
      connectorCapabilities: ['issueTracker.read'],
    },
    activatesWhen: {
      workflows: [
        'implement-ui-change',
        'implement-api-change',
        'review-change',
        'automate-regression-tests',
      ],
    },
  },
  {
    id: 'change-proposal',
    version: '1.1.0',
    title: 'Change proposal',
    description: 'Describe verified changes and propose them as a draft pull request for review.',
    requires: { tools: ['source-control'], connectorCapabilities: ['sourceControl.write'] },
    activatesWhen: {
      workflows: ['implement-ui-change', 'implement-api-change', 'automate-regression-tests'],
    },
  },
  {
    id: 'backend-implementation',
    version: '1.0.0',
    title: 'Backend implementation',
    description:
      'Make focused service and API changes that keep contracts, migrations and error handling consistent with the codebase.',
    requires: {
      tools: ['repository', 'code-editor'],
      connectorCapabilities: ['sourceControl.read'],
    },
    activatesWhen: { workflows: ['implement-api-change'] },
  },
  {
    id: 'backend-verification',
    version: '1.0.0',
    title: 'Backend verification',
    description:
      "Install the project's locked dependencies, then run its lint, type-check and test scripts and fix what they report.",
    requires: { tools: ['dependencies', 'build', 'artifact'], connectorCapabilities: [] },
    activatesWhen: { workflows: ['implement-api-change'] },
  },
  {
    id: 'code-review',
    version: '1.0.0',
    title: 'Code review',
    description:
      'Read a proposed change and its work item, run the project checks, and find defects, risks and missing tests without modifying the repository.',
    requires: {
      tools: ['repository', 'dependencies', 'build'],
      connectorCapabilities: ['sourceControl.read'],
    },
    activatesWhen: { workflows: ['review-change'] },
  },
  {
    id: 'review-reporting',
    version: '1.0.0',
    title: 'Review reporting',
    description:
      'Write an evidence-backed review report for the human reviewer; the reviewer decides what to publish.',
    requires: { tools: ['artifact'], connectorCapabilities: [] },
    activatesWhen: { workflows: ['review-change'] },
  },
  {
    id: 'test-authoring',
    version: '1.0.0',
    title: 'Test authoring',
    description:
      "Write deterministic Playwright regression tests for a work item's acceptance criteria, following the project's existing test layout.",
    requires: {
      tools: ['repository', 'code-editor'],
      connectorCapabilities: ['sourceControl.read'],
    },
    activatesWhen: { workflows: ['automate-regression-tests'] },
  },
  {
    id: 'test-verification',
    version: '1.0.0',
    title: 'Test verification',
    description:
      'Install locked dependencies and run the new tests against the approved QA environment before proposing them.',
    requires: { tools: ['dependencies', 'browser', 'artifact'], connectorCapabilities: [] },
    activatesWhen: { workflows: ['automate-regression-tests'] },
  },
];
