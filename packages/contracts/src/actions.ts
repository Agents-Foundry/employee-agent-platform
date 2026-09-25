// Action Gateway contracts (Architecture V2 Phase D, ADR 0005, ADR 0012).
// Pure types and constants: safe for Angular, Node and runtimes.

/** Connector providers with an implementation in the control plane. */
export const connectorProviders = ['jira'] as const;
export type ConnectorProvider = (typeof connectorProviders)[number];

/**
 * A reference to a secret held by the platform secret store, never the secret itself.
 * References resolve only inside the organization that owns the connection.
 */
export const secretReferencePattern = /^secret:\/\/[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ConnectorConnectionSettings {
  /** Account the API token belongs to (Jira Cloud basic authentication). */
  authEmail?: string;
  /** Project keys the gateway allows writes to. Empty means none. */
  allowedProjects: string[];
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
