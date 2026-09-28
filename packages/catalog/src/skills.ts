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
];
