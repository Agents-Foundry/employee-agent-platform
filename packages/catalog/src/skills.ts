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
];
