export type GovernedAction =
  | 'repository.read'
  | 'jira.read'
  | 'qa.plan'
  | 'qa.execute_playwright'
  | 'jira.issue.create'
  | 'repository.pull_request.create'
  | 'production.deploy';

export interface PolicyDecision {
  outcome: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
}

const decisions: Record<GovernedAction, PolicyDecision> = {
  'repository.read': {
    outcome: 'ALLOW',
    risk: 'LOW',
    reason: 'Read-only repository context is allowed for assigned projects.',
  },
  'jira.read': {
    outcome: 'ALLOW',
    risk: 'LOW',
    reason: 'Read-only work-item context is allowed for assigned projects.',
  },
  'qa.plan': {
    outcome: 'ALLOW',
    risk: 'LOW',
    reason: 'Generating a test plan does not mutate an external system.',
  },
  'qa.execute_playwright': {
    outcome: 'REQUIRE_APPROVAL',
    risk: 'MEDIUM',
    reason: 'Browser execution can affect a target environment and must be approved.',
  },
  'jira.issue.create': {
    outcome: 'REQUIRE_APPROVAL',
    risk: 'MEDIUM',
    reason: 'Creating a Jira issue is an external write.',
  },
  'repository.pull_request.create': {
    outcome: 'REQUIRE_APPROVAL',
    risk: 'HIGH',
    reason: 'Publishing repository changes requires human approval.',
  },
  'production.deploy': {
    outcome: 'DENY',
    risk: 'CRITICAL',
    reason: 'The QA employee agent cannot deploy to production.',
  },
};

export function evaluatePolicy(action: string): PolicyDecision {
  if (!Object.hasOwn(decisions, action)) {
    return { outcome: 'DENY', risk: 'CRITICAL', reason: 'Unknown actions are denied.' };
  }
  return { ...decisions[action as GovernedAction] };
}
