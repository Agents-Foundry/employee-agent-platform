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

/** True only for actions with an explicit decision; catalogs may not declare anything else. */
export function isKnownAction(action: string): boolean {
  return Object.hasOwn(decisions, action);
}

// Policy v2 (Architecture V2 Phase D, ADR 0012): deterministic, contextual evaluation for the
// Action Gateway. Every input can only keep or tighten the platform decision above.

export const POLICY_ID = 'agents-foundry.foundation';
export const POLICY_VERSION = 'foundation-v2';

type Outcome = PolicyDecision['outcome'];
const rank: Record<Outcome, number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 };
const approvalTtlSeconds: Record<PolicyDecision['risk'], number> = {
  LOW: 24 * 3600,
  MEDIUM: 24 * 3600,
  HIGH: 8 * 3600,
  CRITICAL: 3600,
};

export type PolicyCondition =
  /** A resulting approval expires after this many seconds. */
  | { type: 'APPROVAL_TTL_SECONDS'; value: number }
  /** The approval covers only the exact payload whose digest was requested. */
  | { type: 'BIND_TO_INPUT_DIGEST' };

export interface ActionPolicyContext {
  action: string;
  organizationId: string;
  actor: { kind: 'AGENT'; agentId: string; employeeId: string };
  /** Outcome pinned for the action in the agent's signed manifest; null when not granted. */
  manifestOutcome: Outcome | null;
  /** Organization override; can only tighten. */
  organizationOutcome: 'REQUIRE_APPROVAL' | 'DENY' | null;
  /** The external resource, and whether it lies inside the configured scope. */
  resource?: { type: string; id: string; inScope: boolean };
}

export interface ActionPolicyDecision extends PolicyDecision {
  policyId: string;
  policyVersion: string;
  conditions: PolicyCondition[];
}

/** Deterministic Policy v2 decision. It never calls out and never consults a model. */
export function evaluateActionPolicy(context: ActionPolicyContext): ActionPolicyDecision {
  const decide = (outcome: Outcome, risk: PolicyDecision['risk'], reason: string) => ({
    outcome,
    risk,
    reason,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    conditions:
      outcome === 'REQUIRE_APPROVAL'
        ? [
            { type: 'APPROVAL_TTL_SECONDS' as const, value: approvalTtlSeconds[risk] },
            { type: 'BIND_TO_INPUT_DIGEST' as const },
          ]
        : [],
  });
  const base = evaluatePolicy(context.action);
  if (base.outcome === 'DENY') return decide('DENY', base.risk, base.reason);
  if (context.manifestOutcome === null)
    return decide('DENY', 'CRITICAL', 'The agent manifest does not grant this action.');
  if (context.resource && !context.resource.inScope)
    return decide('DENY', base.risk, 'The target resource is outside the configured scope.');
  let outcome: Outcome = base.outcome;
  let reason = base.reason;
  if (rank[context.manifestOutcome] > rank[outcome]) {
    outcome = context.manifestOutcome;
    reason = 'Restricted by the agent manifest.';
  }
  if (context.organizationOutcome && rank[context.organizationOutcome] > rank[outcome]) {
    outcome = context.organizationOutcome;
    reason = 'Restricted by organization policy.';
  }
  return decide(outcome, base.risk, reason);
}

/** Actions with an explicit platform decision, for administration views. */
export function knownActions(): string[] {
  return Object.keys(decisions);
}
