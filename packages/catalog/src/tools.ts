import type { ToolDefinition } from '../../contracts/src/catalog.js';

export const tools: ToolDefinition[] = [
  {
    id: 'repository',
    version: '1.0.0',
    description: 'Search, read and diff assigned repositories; publish changes only when approved.',
    risk: 'MEDIUM',
    executionLocation: 'EXECUTION_RUNTIME',
    sideEffects: 'EXTERNAL_WRITE',
    governedActions: ['repository.read', 'repository.pull_request.create'],
    timeoutMs: 120_000,
  },
  {
    id: 'issue-tracker',
    version: '1.0.0',
    description: 'Read work items and request governed issue creation.',
    risk: 'MEDIUM',
    executionLocation: 'CONTROL_PLANE',
    sideEffects: 'EXTERNAL_WRITE',
    governedActions: ['jira.read', 'jira.issue.create'],
    timeoutMs: 30_000,
  },
  {
    id: 'browser',
    version: '1.0.0',
    description: 'Run isolated browser and Playwright checks against an approved environment.',
    risk: 'MEDIUM',
    executionLocation: 'EXECUTION_RUNTIME',
    sideEffects: 'EXTERNAL_WRITE',
    governedActions: ['qa.execute_playwright'],
    timeoutMs: 900_000,
  },
  {
    id: 'artifact',
    version: '1.0.0',
    description: 'Register evidence artifacts produced during a run.',
    risk: 'LOW',
    executionLocation: 'EXECUTION_RUNTIME',
    sideEffects: 'LOCAL_WRITE',
    governedActions: [],
    timeoutMs: 60_000,
  },
];
