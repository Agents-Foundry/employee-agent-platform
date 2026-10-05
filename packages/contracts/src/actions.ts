// Action Gateway contracts (Architecture V2 Phase D, ADR 0005, ADR 0012).
// Pure types and constants: safe for Angular, Node and runtimes.

/** Connector providers with an implementation in the control plane. */
export const connectorProviders = ['jira', 'github'] as const;
export type ConnectorProvider = (typeof connectorProviders)[number];

/**
 * A reference to a secret held by the platform secret store, never the secret itself.
 * References resolve only inside the organization that owns the connection.
 */
export const secretReferencePattern = /^secret:\/\/[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ConnectorConnectionSettings {
  /** Account the API token belongs to (Jira Cloud basic authentication). */
  authEmail?: string;
  /** Issue-tracker project keys the gateway allows. Empty means none (always empty for GitHub). */
  allowedProjects: string[];
  /** Source-control repositories (`owner/name`) the gateway allows (Phase G, GitHub). */
  allowedRepositories?: string[];
}

/** An organization's configured connection to an external system. Admin-visible; holds no secret. */
export interface ConnectorConnection {
  id: string;
  organizationId: string;
  provider: ConnectorProvider;
  name: string;
  baseUrl: string;
  secretRef: string;
  settings: ConnectorConnectionSettings;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorConnectionInput {
  provider: ConnectorProvider;
  name: string;
  baseUrl: string;
  secretRef: string;
  settings: ConnectorConnectionSettings;
}

/** Organization overrides can only tighten the platform policy, never loosen it. */
export type OrganizationPolicyOutcome = 'REQUIRE_APPROVAL' | 'DENY';

export interface OrganizationActionPolicy {
  organizationId: string;
  action: string;
  outcome: OrganizationPolicyOutcome;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

/** One governed action as shown to organization administrators. */
export interface GovernedActionSummary {
  action: string;
  defaultOutcome: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Executed by the control plane through a connector, rather than by the runtime. */
  executedBy: 'CONTROL_PLANE' | 'RUNTIME';
  connectorProvider: ConnectorProvider | null;
  override: OrganizationActionPolicy | null;
}

/** Approval states for governed actions; `EXPIRED` approvals can never be executed. */
export type ActionApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** Why a governed write's outcome is unknown (ADR 0036). */
export type ActionReconciliationReason = 'CONNECTOR_OUTCOME_UNKNOWN' | 'DISPATCH_INTERRUPTED';

/**
 * A governed write whose outcome nobody knows, as shown to organization administrators
 * (ADR 0036, ADR 0039). It carries the control plane's own one-line summary of the request,
 * with anything that looks like a credential removed, never the request's payload.
 */
export interface ActionReconciliation {
  requestId: string;
  runId: string;
  threadId: string;
  stepId: string | null;
  action: string;
  /** What the write was aimed at, for example an issue-tracker project or a repository. */
  target: { type: string; id: string } | null;
  /** The summary an approver saw, redacted. Null when none can be written safely. */
  summary: string | null;
  reason: ActionReconciliationReason;
  state: 'REQUIRED' | 'APPLIED' | 'NOT_APPLIED';
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
}
