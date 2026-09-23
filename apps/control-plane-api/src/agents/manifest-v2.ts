import type {
  AgentManifestPayload,
  AgentManifestV2Payload,
  AnyAgentManifestPayload,
  ConnectorRequirement,
  KeySource,
  ManifestCapability,
} from '@agents-foundry/contracts';
import { qaBlueprint } from '../blueprints.js';

export const POLICY_VERSION = 'foundation-approval-v1';

/** Fields every issued manifest resolves, whichever version is signed. */
export interface ManifestIssue {
  manifestId: string;
  agentId: string;
  organizationId: string;
  employeeId: string;
  issuedAt: string;
  agentName: string;
  blueprintId: string;
  blueprintVersion: string;
  provider: string;
  model: string;
  credentialMode: KeySource;
  answers: Record<string, string | string[]>;
  capabilities: ManifestCapability[];
}

type RoleSections = Omit<
  AgentManifestV2Payload,
  | 'apiVersion'
  | 'kind'
  | 'metadata'
  | 'identity'
  | 'model'
  | 'policies'
  | 'configuration'
  | 'conversationSync'
> & { role: string; department: string; modelProfile: string; policyProfile: string };

const providerIds: Record<string, string> = {
  Jira: 'jira',
  'Azure DevOps': 'azure-devops',
  Linear: 'linear',
  Bitbucket: 'bitbucket',
  GitHub: 'github',
  GitLab: 'gitlab',
};

function selections(answers: Record<string, string | string[]>, key: string): string[] {
  const value = answers[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Phase A compatibility adapter (ADR 0009): declarative v2 sections for blueprints that predate
 * the catalog. Phase B replaces this registry with versioned catalog entries; it is data, not
 * runtime behaviour, and nothing downstream branches on the role.
 */
const blueprintSections: Record<
  string,
  (answers: Record<string, string | string[]>) => RoleSections
> = {
  [qaBlueprint.id]: (answers) => {
    const connectors: ConnectorRequirement[] = [
      ...selections(answers, 'issueTracker').map((name) => ({
        id: providerIds[name]!,
        capabilities: ['issueTracker.read'],
      })),
      ...selections(answers, 'sourceControl').map((name) => ({
        id: providerIds[name]!,
        capabilities: ['sourceControl.read'],
      })),
    ];
    return {
      role: 'qa-engineer',
      department: qaBlueprint.department,
      modelProfile: 'qa-default',
      policyProfile: 'qa-standard',
      persona: { profile: 'qa-engineer-default' },
      runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
      skills: qaBlueprint.skills.map((id) => ({ id, version: '1.0.0' })),
      tools: ['repository', 'browser', 'artifact'],
      connectors,
      mcp: selections(answers, 'testingTechnologies').includes('Playwright') ? ['playwright'] : [],
      memory: { profile: 'project-employee-memory' },
      knowledge: { sources: ['assigned-repositories', 'issue-tracker-project'] },
      workflows: ['validate-story', 'sanity-test', 'regression-test', 'post-release-validation'],
      evaluations: { suite: 'qa-engineer-v1' },
    };
  },
};

export function buildManifestV1(issue: ManifestIssue): AgentManifestPayload {
  return {
    apiVersion: 'agents-foundry/v1',
    manifestId: issue.manifestId,
    agentId: issue.agentId,
    organizationId: issue.organizationId,
    employeeId: issue.employeeId,
    blueprint: { id: issue.blueprintId, version: issue.blueprintVersion },
    model: { provider: issue.provider, model: issue.model, credentialMode: issue.credentialMode },
    answers: issue.answers,
    capabilities: issue.capabilities,
    conversationSync: 'REQUIRED',
    policyVersion: POLICY_VERSION,
    issuedAt: issue.issuedAt,
  };
}

export function buildManifestV2(issue: ManifestIssue): AgentManifestV2Payload {
  const resolve = Object.hasOwn(blueprintSections, issue.blueprintId)
    ? blueprintSections[issue.blueprintId]
    : undefined;
  if (!resolve) throw new Error('BLUEPRINT_UNSUPPORTED');
  const { role, department, modelProfile, policyProfile, ...sections } = resolve(issue.answers);
  return {
    apiVersion: 'agents-foundry/v2',
    kind: 'AgentManifest',
    metadata: {
      manifestId: issue.manifestId,
      agentId: issue.agentId,
      organizationId: issue.organizationId,
      employeeId: issue.employeeId,
      issuedAt: issue.issuedAt,
      blueprint: { id: issue.blueprintId, version: issue.blueprintVersion },
    },
    identity: { name: issue.agentName, role, department },
    ...sections,
    model: {
      profile: modelProfile,
      provider: issue.provider,
      model: issue.model,
      credentialMode: issue.credentialMode,
    },
    policies: {
      profile: policyProfile,
      policyVersion: POLICY_VERSION,
      capabilities: issue.capabilities,
    },
    configuration: issue.answers,
    conversationSync: 'REQUIRED',
  };
}

export function buildManifestPayload(issue: ManifestIssue, v2: boolean): AnyAgentManifestPayload {
  return v2 ? buildManifestV2(issue) : buildManifestV1(issue);
}
