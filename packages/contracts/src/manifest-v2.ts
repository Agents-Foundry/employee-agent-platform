// Agent Manifest v2 (ADR 0004): the fully resolved runtime configuration of one assigned
// employee agent. Declarative only; runtimes must deny anything the manifest does not list.
import type { KeySource, ManifestCapability } from './index.js';

export interface VersionedReference {
  id: string;
  /** Exact version resolved at issuance; constraints are resolved before signing. */
  version: string;
}

export interface ConnectorRequirement {
  id: string;
  /** Capability identifiers such as `issueTracker.read`; never raw provider API scopes. */
  capabilities: string[];
}

export interface AgentManifestV2Payload {
  apiVersion: 'agents-foundry/v2';
  kind: 'AgentManifest';
  metadata: {
    manifestId: string;
    agentId: string;
    organizationId: string;
    employeeId: string;
    issuedAt: string;
    blueprint: VersionedReference;
  };
  identity: { name: string; role: string; department: string };
  persona: { profile: string };
  runtime: { profile: string; isolation: 'sandboxed' | 'local' };
  model: { profile: string; provider: string; model: string; credentialMode: KeySource };
  skills: VersionedReference[];
  tools: string[];
  connectors: ConnectorRequirement[];
  mcp: string[];
  memory: { profile: string };
  knowledge: { sources: string[] };
  policies: { profile: string; policyVersion: string; capabilities: ManifestCapability[] };
  workflows: string[];
  evaluations: { suite: string };
  /** Installation answers resolved for this agent (for example the QA environment URL). */
  configuration: Record<string, string | string[]>;
  conversationSync: 'REQUIRED';
}
