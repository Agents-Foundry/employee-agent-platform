export type Identifier = string;

export type UserRole = 'ADMIN' | 'EMPLOYEE';
export interface Actor {
  id: string;
  organizationId: string;
  role: UserRole;
}

export type PublicAuthConfig =
  | { mode: 'demo' }
  | {
      mode: 'google';
      workspaceDomain: string;
    };
export type KeySource = 'EMPLOYEE_BYOK' | 'ORGANIZATION_MANAGED';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type QaRunStatus = 'AWAITING_APPROVAL' | 'READY' | 'REJECTED';

export interface Organization {
  id: Identifier;
  name: string;
  slug: string;
}

export interface Employee {
  id: Identifier;
  organizationId: Identifier;
  displayName: string;
  email: string;
  role: UserRole;
  team: string;
}

export interface AgentDefinition {
  id: Identifier;
  organizationId: Identifier;
  name: string;
  department: string;
  team: string;
  status: 'ACTIVE' | 'DISABLED';
  capabilities: string[];
  employeeId?: Identifier;
}

export interface BlueprintQuestion {
  id: string;
  label: string;
  type: 'text' | 'url' | 'multiselect';
  required: boolean;
  options?: string[];
}

export interface AgentBlueprint {
  id: string;
  version: string;
  title: string;
  department: string;
  mission: string;
  skills: string[];
  questionnaire: BlueprintQuestion[];
  capabilities: ManifestCapability[];
}

export interface ManifestCapability {
  action: string;
  outcome: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
}

export interface ProvisioningInput {
  blueprintId: string;
  blueprintVersion: string;
  provider: string;
  model: string;
  credentialMode: KeySource;
  answers: Record<string, string | string[]>;
}

export interface ProvisioningRequest extends ProvisioningInput {
  id: string;
  organizationId: string;
  employeeId: string;
  status: ApprovalStatus;
  capabilities: ManifestCapability[];
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  agentId?: string;
}

export interface AgentManifestPayload {
  apiVersion: 'agents-foundry/v1';
  manifestId: string;
  agentId: string;
  organizationId: string;
  employeeId: string;
  blueprint: { id: string; version: string };
  model: { provider: string; model: string; credentialMode: KeySource };
  answers: Record<string, string | string[]>;
  capabilities: ManifestCapability[];
  conversationSync: 'REQUIRED';
  policyVersion: string;
  issuedAt: string;
}

export interface SignedAgentManifest {
  payload: AgentManifestPayload;
  signature: string;
  algorithm: 'Ed25519';
  keyId: string;
}

export interface ManifestVerificationKey {
  keyId: string;
  algorithm: 'Ed25519';
  publicKeySpki: string;
}

export interface LifecycleEvent {
  id: string;
  organizationId: string;
  actorId: string;
  type:
    | 'provisioning.requested'
    | 'provisioning.approved'
    | 'provisioning.rejected'
    | 'agent.manifest.issued';
  subjectId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface KeyPolicy {
  allowedSources: KeySource[];
  defaultSource: KeySource;
  secretStorageRule: string;
}

export interface Conversation {
  id: Identifier;
  organizationId: Identifier;
  employeeId: Identifier;
  agentId: Identifier;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: Identifier;
  conversationId: Identifier;
  author: 'EMPLOYEE' | 'AGENT' | 'SYSTEM';
  content: string;
  createdAt: string;
}

export interface Approval {
  id: Identifier;
  organizationId: Identifier;
  requestedBy: Identifier;
  action: string;
  resourceType: string;
  resourceId: Identifier;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  status: ApprovalStatus;
  decidedBy?: Identifier;
  decidedAt?: string;
  createdAt: string;
}

export interface QaRun {
  id: Identifier;
  organizationId: Identifier;
  employeeId: Identifier;
  conversationId: Identifier;
  storyKey: string;
  targetUrl: string;
  status: QaRunStatus;
  plan: string[];
  approvalId: Identifier;
  createdAt: string;
}

export interface BootstrapResponse {
  organization: Organization;
  employee: Employee;
  agents: AgentDefinition[];
  keyPolicy: KeyPolicy;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
}

export interface QaRunRequest {
  employeeId: Identifier;
  conversationId: Identifier;
  storyKey: string;
  targetUrl: string;
}

export interface QaRunResponse {
  run: QaRun;
  approval: Approval;
}
