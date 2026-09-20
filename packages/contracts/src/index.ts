export type Identifier = string;

export type UserRole = 'ADMIN' | 'EMPLOYEE';
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
