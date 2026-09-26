import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type {
  AgentManifestV2Payload,
  RuntimeActionDecision,
  RuntimeActionExecuteRequest,
  RuntimeActionExecution,
  RuntimeActionRequest,
  RuntimeClaimResponse,
  RuntimeCorrelation,
  RuntimeEventAck,
  RuntimeEventEnvelope,
  SignedAgentManifestV2,
  SignedExecutionGrant,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import { parseRuntimeEvent } from '../../../packages/contracts/src/runtime/v1/schemas.js';
import { MemoryCheckpointStore } from '../src/checkpoints.js';
import { ControlPlaneError } from '../src/errors.js';
import { NativeKernel } from '../src/kernel/native-kernel.js';
import { ManifestVerifier } from '../src/manifest-verifier.js';
import {
  ModelGateway,
  type CredentialBroker,
  type ModelProvider,
} from '../src/models/model-gateway.js';
import { RuntimeHost } from '../src/runtime-host.js';
import { MemoryArtifactStore } from '../src/tools/artifact-store.js';
import { ArtifactTool } from '../src/tools/artifact-tool.js';
import { ToolRegistry, type RuntimeTool } from '../src/tools/runtime-tool.js';
import type { ControlPlanePort } from '../src/transport/control-plane-client.js';

export const signingKey = generateKeyPairSync('ed25519');
export const manifestKeySpki = signingKey.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

export function correlation(): RuntimeCorrelation {
  return {
    organizationId: 'org_test',
    employeeId: 'employee_test',
    agentId: 'agent_test',
    threadId: randomUUID(),
    runId: randomUUID(),
  };
}

export function signedManifest(
  subject: RuntimeCorrelation,
  change: (payload: AgentManifestV2Payload) => void = () => undefined,
  key = signingKey.privateKey,
): SignedAgentManifestV2 {
  const payload: AgentManifestV2Payload = {
    apiVersion: 'agents-foundry/v2',
    kind: 'AgentManifest',
    metadata: {
      manifestId: randomUUID(),
      agentId: subject.agentId,
      organizationId: subject.organizationId,
      employeeId: subject.employeeId,
      issuedAt: new Date().toISOString(),
      blueprint: { id: 'engineering.qa-engineer', version: '1.1.0', digest: 'd'.repeat(64) },
    },
    identity: { name: 'QA Agent', role: 'qa-engineer', department: 'Engineering' },
    persona: { profile: 'qa-engineer-default' },
    runtime: { profile: 'standard-agent', isolation: 'sandboxed' },
    model: {
      profile: 'qa-default',
      provider: 'test-provider',
      model: 'test-model',
      credentialMode: 'ORGANIZATION_MANAGED',
    },
    skills: [],
    tools: ['artifact', 'issue-tracker'],
    connectors: [],
    mcp: [],
    memory: { profile: 'project-employee-memory' },
    knowledge: { sources: [] },
    policies: { profile: 'qa-standard', policyVersion: 'test', capabilities: [] },
    workflows: ['validate-story'],
    evaluations: { suite: 'qa-engineer-v1' },
    configuration: { projectName: 'Checkout' },
    conversationSync: 'REQUIRED',
  };
  change(payload);
  const signature = sign(null, Buffer.from(canonicalManifest(payload)), key).toString('base64');
  return {
    payload,
    signature,
    algorithm: 'Ed25519',
    keyId: new ManifestVerifier(manifestKeySpki).keyId,
  };
}

/**
 * In-memory control plane. Enforces what the real one enforces for runtimes: strict event
 * parsing and contiguous sequences. Tests queue commands and choose action decisions.
 */
export class FakeControlPlane implements ControlPlanePort {
  readonly claims: RuntimeClaimResponse[] = [];
  readonly events: RuntimeEventEnvelope[] = [];
  readonly actions: RuntimeActionRequest[] = [];
  readonly sequences = new Map<string, number>();
  decide: (request: RuntimeActionRequest) => RuntimeActionDecision = (request) => ({
    requestId: request.requestId,
    decision: 'ALLOWED',
    risk: 'LOW',
    reason: 'test',
  });
  rejectEvents = false;

  async claim(): Promise<RuntimeClaimResponse | null> {
    return this.claims.shift() ?? null;
  }

  async sendEvent(event: RuntimeEventEnvelope): Promise<RuntimeEventAck> {
    if (this.rejectEvents) throw new ControlPlaneError(409, 'RUN_TERMINAL');
    const parsed = parseRuntimeEvent(event);
    const last = this.sequences.get(parsed.runId) ?? 0;
    if (parsed.sequence !== last + 1)
      throw new ControlPlaneError(409, 'RUNTIME_EVENT_OUT_OF_ORDER');
    this.sequences.set(parsed.runId, parsed.sequence);
    this.events.push(parsed);
    return { eventId: parsed.eventId, sequence: this.events.length, duplicate: false };
  }

  async requestAction(request: RuntimeActionRequest): Promise<RuntimeActionDecision> {
    this.actions.push(request);
    return this.decide(request);
  }

  readonly executions: RuntimeActionExecuteRequest[] = [];
  execute: (request: RuntimeActionExecuteRequest) => RuntimeActionExecution = (request) => ({
    requestId: request.requestId,
    status: 'SUCCEEDED',
    result: { issueKey: 'QA-1', url: 'https://jira.example.com/browse/QA-1' },
  });

  async executeAction(request: RuntimeActionExecuteRequest): Promise<RuntimeActionExecution> {
    this.executions.push(request);
    return this.execute(request);
  }

  readonly grants: RuntimeActionExecuteRequest[] = [];
  grant: (request: RuntimeActionExecuteRequest) => SignedExecutionGrant = () => {
    throw new ControlPlaneError(409, 'ACTION_NOT_GRANTABLE');
  };

  async requestGrant(request: RuntimeActionExecuteRequest): Promise<SignedExecutionGrant> {
    this.grants.push(request);
    return this.grant(request);
  }

  types(runId: string): string[] {
    return this.events.filter((event) => event.runId === runId).map((event) => event.type);
  }

  submit(
    subject: RuntimeCorrelation,
    manifest: SignedAgentManifestV2,
    objective = 'Validate STORY-1',
    workflow?: WorkflowDefinition,
  ) {
    this.claims.push({
      command: {
        protocol: 'agents-foundry/runtime/v1',
        type: 'run.submit',
        commandId: randomUUID(),
        issuedAt: new Date().toISOString(),
        correlation: subject,
        run: {
          runId: subject.runId,
          threadId: subject.threadId,
          task: { objective, workflow: 'validate-story', inputs: {} },
          runtimeProfile: 'standard-agent',
          manifest,
          workspace: null,
          ...(workflow ? { workflow } : {}),
        },
      },
      lease: {
        sessionId: randomUUID(),
        runtimeSequence: 0,
        leaseExpiresAt: new Date().toISOString(),
      },
    });
  }

  resume(subject: RuntimeCorrelation, approvalId: string) {
    this.claims.push({
      command: {
        protocol: 'agents-foundry/runtime/v1',
        type: 'run.resume',
        commandId: randomUUID(),
        issuedAt: new Date().toISOString(),
        correlation: subject,
        runId: subject.runId,
        approval: { approvalId, decision: 'APPROVED', decidedAt: new Date().toISOString() },
      },
      lease: {
        sessionId: randomUUID(),
        runtimeSequence: this.sequences.get(subject.runId) ?? 0,
        leaseExpiresAt: new Date().toISOString(),
      },
    });
  }
}

export const staticCredentials: CredentialBroker = { resolve: async () => ({ apiKey: 'k' }) };
export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createHost(options: {
  controlPlane: FakeControlPlane;
  provider: ModelProvider;
  tools?: RuntimeTool[];
  credentials?: CredentialBroker;
  maxTurns?: number;
}) {
  const artifacts = new MemoryArtifactStore();
  const checkpoints = new MemoryCheckpointStore();
  const host = new RuntimeHost({
    controlPlane: options.controlPlane,
    verifier: new ManifestVerifier(manifestKeySpki),
    kernel: new NativeKernel({ maxTurns: options.maxTurns ?? 6 }),
    models: new ModelGateway([options.provider], options.credentials ?? staticCredentials),
    tools: new ToolRegistry(options.tools ?? [new ArtifactTool()]),
    artifacts,
    checkpoints,
    logger: silentLogger,
  });
  return { host, artifacts, checkpoints };
}
