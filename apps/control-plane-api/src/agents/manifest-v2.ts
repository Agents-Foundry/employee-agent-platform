import type {
  AgentManifestPayload,
  AgentManifestV2Payload,
  AnyAgentManifestPayload,
  KeySource,
  ManifestCapability,
  ResolvedBlueprintBundle,
} from '@agents-foundry/contracts';

export const POLICY_VERSION = 'foundation-approval-v1';

/** Everything an issued manifest resolves, whichever version is signed. */
export interface ManifestIssue {
  manifestId: string;
  agentId: string;
  organizationId: string;
  employeeId: string;
  issuedAt: string;
  agentName: string;
  bundle: ResolvedBlueprintBundle;
  installationId: string | null;
  provider: string;
  model: string;
  credentialMode: KeySource;
  answers: Record<string, string | string[]>;
  /** Fixed at request time for employee requests; policy outcomes otherwise. */
  capabilities: ManifestCapability[];
}

function selections(answers: Record<string, string | string[]>, questionId: string): string[] {
  const value = answers[questionId];
  return Array.isArray(value) ? value : [];
}

export function buildManifestV1(issue: ManifestIssue): AgentManifestPayload {
  return {
    apiVersion: 'agents-foundry/v1',
    manifestId: issue.manifestId,
    agentId: issue.agentId,
    organizationId: issue.organizationId,
    employeeId: issue.employeeId,
    blueprint: { id: issue.bundle.blueprint.id, version: issue.bundle.blueprint.version },
    model: { provider: issue.provider, model: issue.model, credentialMode: issue.credentialMode },
    answers: issue.answers,
    capabilities: issue.capabilities,
    conversationSync: 'REQUIRED',
    policyVersion: POLICY_VERSION,
    issuedAt: issue.issuedAt,
  };
}

/**
 * Resolve a catalog bundle and validated answers into a v2 manifest (ADR 0004, ADR 0009).
 * Entirely data-driven: connectors and MCP servers follow the blueprint's declared answer
 * mappings, so a new role needs a new catalog entry, not a code change here.
 */
export function buildManifestV2(issue: ManifestIssue): AgentManifestV2Payload {
  const { blueprint, digest } = issue.bundle;
  const connectors = blueprint.connectors.flatMap((requirement) =>
    selections(issue.answers, requirement.selection.questionId).map((option) => {
      const id = requirement.selection.providers[option];
      if (!id) throw new Error('CONNECTOR_SELECTION_UNMAPPED');
      return { id, capabilities: [...requirement.capabilities] };
    }),
  );
  const mcp = blueprint.mcp
    .filter(
      ({ whenAnswer }) =>
        !whenAnswer ||
        selections(issue.answers, whenAnswer.questionId).includes(whenAnswer.includes),
    )
    .map(({ id }) => id);
  return {
    apiVersion: 'agents-foundry/v2',
    kind: 'AgentManifest',
    metadata: {
      manifestId: issue.manifestId,
      agentId: issue.agentId,
      organizationId: issue.organizationId,
      employeeId: issue.employeeId,
      issuedAt: issue.issuedAt,
      blueprint: { id: blueprint.id, version: blueprint.version, digest },
      ...(issue.installationId ? { installationId: issue.installationId } : {}),
    },
    identity: { name: issue.agentName, role: blueprint.role, department: blueprint.department },
    persona: { ...blueprint.persona },
    runtime: { ...blueprint.runtime },
    model: {
      profile: blueprint.model.profile,
      provider: issue.provider,
      model: issue.model,
      credentialMode: issue.credentialMode,
    },
    skills: blueprint.skills.map(({ id, version }) => ({ id, version })),
    tools: blueprint.tools.map(({ id }) => id),
    connectors,
    mcp,
    memory: { ...blueprint.memory },
    knowledge: { sources: [...blueprint.knowledge.sources] },
    policies: {
      profile: blueprint.policy.profile,
      policyVersion: POLICY_VERSION,
      capabilities: issue.capabilities,
    },
    workflows: blueprint.workflows.map(({ id }) => id),
    evaluations: { ...blueprint.evaluations },
    configuration: issue.answers,
    conversationSync: 'REQUIRED',
  };
}

export function buildManifestPayload(issue: ManifestIssue, v2: boolean): AnyAgentManifestPayload {
  return v2 ? buildManifestV2(issue) : buildManifestV1(issue);
}
