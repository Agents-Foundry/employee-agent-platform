// Agent catalog (Architecture V2 Phase B, ADR 0009). Role expertise is declarative data:
// the platform validates, versions and resolves it but never branches on a role.
import type { ApprovalRisk } from './execution.js';
import type { VersionedReference } from './manifest-v2.js';
import type { BlueprintQuestion, ManifestCapability } from './index.js';

export interface SkillDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  /** Tools and connector capabilities the skill cannot work without. */
  requires: { tools: string[]; connectorCapabilities: string[] };
  /** Workflows in which the runtime may activate the skill. */
  activatesWhen: { workflows: string[] };
}

export type ToolExecutionLocation = 'LOCAL' | 'EXECUTION_RUNTIME' | 'CONTROL_PLANE';
export type ToolSideEffects = 'NONE' | 'LOCAL_WRITE' | 'EXTERNAL_WRITE';

/** Tool metadata only; implementations live in runtimes, permissions in policy. */
export interface ToolDefinition {
  id: string;
  version: string;
  description: string;
  risk: ApprovalRisk;
  executionLocation: ToolExecutionLocation;
  sideEffects: ToolSideEffects;
  /** Governed actions the tool can request through the Action Gateway. */
  governedActions: string[];
  timeoutMs: number;
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  skill: string;
  /** Governed action this step may request; policy decides the outcome. */
  action?: string;
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  steps: WorkflowStepDefinition[];
}

/** A connector need expressed as a capability, resolved to a provider from an answer. */
export interface ConnectorRequirementDefinition {
  capability: string;
  capabilities: string[];
  selection: { questionId: string; providers: Record<string, string> };
}

export interface McpRequirementDefinition {
  id: string;
  whenAnswer?: { questionId: string; includes: string };
}

/** Who supplies a questionnaire answer: once per installation, or per agent instance. */
export type QuestionScope = 'INSTALLATION' | 'AGENT';

export interface CatalogQuestion extends BlueprintQuestion {
  scope: QuestionScope;
}

export interface AgentBlueprintVersionDefinition {
  id: string;
  version: string;
  title: string;
  department: string;
  role: string;
  mission: string;
  persona: { profile: string };
  runtime: { profile: string; isolation: 'sandboxed' | 'local' };
  model: { profile: string };
  skills: VersionedReference[];
  tools: VersionedReference[];
  workflows: VersionedReference[];
  connectors: ConnectorRequirementDefinition[];
  mcp: McpRequirementDefinition[];
  memory: { profile: string };
  knowledge: { sources: string[] };
  /** Actions this role may ever request; outcomes come from the policy engine. */
  policy: { profile: string; actions: string[] };
  evaluations: { suite: string };
  questionnaire: CatalogQuestion[];
}

export interface CatalogDefinitions {
  skills: SkillDefinition[];
  tools: ToolDefinition[];
  workflows: WorkflowDefinition[];
  blueprints: AgentBlueprintVersionDefinition[];
}

/** A blueprint version with the exact skill, tool and workflow versions it references. */
export interface ResolvedBlueprintBundle {
  blueprint: AgentBlueprintVersionDefinition;
  skills: SkillDefinition[];
  tools: ToolDefinition[];
  workflows: WorkflowDefinition[];
  capabilities: ManifestCapability[];
  /** SHA-256 of the canonical bundle; pinned by installations and manifests. */
  digest: string;
}

export interface CatalogBlueprintSummary {
  id: string;
  version: string;
  title: string;
  department: string;
  role: string;
  mission: string;
  digest: string;
  latest: boolean;
}

export type InstallationStatus = 'ACTIVE' | 'RETIRED';

export interface OrganizationAgentInstallation {
  id: string;
  organizationId: string;
  name: string;
  blueprintId: string;
  blueprintVersion: string;
  blueprintDigest: string;
  /** Validated answers to the blueprint's INSTALLATION-scoped questions. */
  configuration: Record<string, string | string[]>;
  status: InstallationStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInstallationInput {
  name: string;
  blueprintId: string;
  blueprintVersion: string;
  configuration: Record<string, string | string[]>;
}
