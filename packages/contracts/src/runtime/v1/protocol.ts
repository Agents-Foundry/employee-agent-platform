// agents-foundry/runtime/v1 — the only contract between the control plane and an agent runtime
// (ADR 0002). Changes that are not strictly additive require a new protocol version.
import type { ArtifactRegistration } from '../../artifacts.js';
import type {
  ExecutionError,
  RunStepKind,
  RuntimeCorrelation,
  RuntimeEventType,
  TaskSpec,
  WorkspaceBinding,
} from '../../execution.js';
import type { WorkflowDefinition } from '../../catalog.js';
import type { SignedAgentManifestV2 } from '../../index.js';

export const RUNTIME_PROTOCOL_V1 = 'agents-foundry/runtime/v1' as const;
export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_V1;

interface CommandBase {
  protocol: RuntimeProtocolVersion;
  commandId: string;
  issuedAt: string;
  correlation: RuntimeCorrelation;
}

/** Start a run. The runtime must verify the signed manifest before doing anything else. */
export interface RunSubmitCommand extends CommandBase {
  type: 'run.submit';
  run: {
    runId: string;
    threadId: string;
    task: TaskSpec;
    runtimeProfile: string;
    manifest: SignedAgentManifestV2;
    workspace: WorkspaceBinding | null;
    /**
     * The task's workflow resolved by the control plane from the agent's pinned catalog
     * bundle (Phase F). Guidance for the kernel only: every step's action is still decided by
     * the control plane when requested. Absent when the task names no workflow.
     */
    workflow?: WorkflowDefinition;
  };
}

/** Deliver a human approval decision to a run that paused for it. */
export interface RunResumeCommand extends CommandBase {
  type: 'run.resume';
  runId: string;
  approval: { approvalId: string; decision: 'APPROVED' | 'REJECTED'; decidedAt: string };
}

export interface RunCancelCommand extends CommandBase {
  type: 'run.cancel';
  runId: string;
  reason: string;
}

export type RuntimeCommand = RunSubmitCommand | RunResumeCommand | RunCancelCommand;

/** Payload for each runtime-emitted event type. Digests replace raw tool input/output. */
export interface RuntimeEventPayloads {
  'run.started': { runtimeSessionId: string; kernel: string };
  'run.paused': { reason: 'APPROVAL_REQUIRED'; actionId: string };
  'run.resumed': { approvalId: string };
  'run.completed': { summary: string; artifactIds: string[] };
  'run.failed': { error: ExecutionError; retryable: boolean };
  'run.cancelled': { reason: string };
  'step.started': { kind: RunStepKind; title: string };
  'step.completed': { outputSummary?: string };
  'step.failed': { error: ExecutionError };
  'agent.message': { content: string };
  'agent.reasoning.started': Record<string, never>;
  'model.requested': { modelProfile: string; capability: string };
  'model.responded': {
    modelProfile: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    finishReason: string;
  };
  'tool.requested': {
    toolCallId: string;
    toolId: string;
    toolVersion: string;
    inputDigest: string;
  };
  'tool.started': { toolCallId: string };
  'tool.completed': {
    toolCallId: string;
    outputDigest: string;
    durationMs: number;
    artifactIds: string[];
  };
  'tool.failed': { toolCallId: string; error: ExecutionError; durationMs: number };
  'artifact.created': { artifact: ArtifactRegistration };
}

export type RuntimeEventEnvelope = {
  [K in RuntimeEventType]: {
    protocol: RuntimeProtocolVersion;
    /** Globally unique; redelivery of the same event is idempotent. */
    eventId: string;
    runId: string;
    threadId: string;
    stepId?: string;
    /** Runtime-assigned, contiguous from 1 per run. */
    sequence: number;
    type: K;
    occurredAt: string;
    correlation: RuntimeCorrelation;
    payload: RuntimeEventPayloads[K];
  };
}[RuntimeEventType];
