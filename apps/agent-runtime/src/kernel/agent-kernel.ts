import type {
  RuntimeActionDecision,
  RuntimeActionRequest,
  RuntimeCorrelation,
  RuntimeEventPayloads,
  RuntimeEventType,
  SignedAgentManifestV2,
  TaskSpec,
} from '@agents-foundry/contracts';
import type { RuntimeFailure } from '../errors.js';
import type { ModelGateway } from '../models/model-gateway.js';
import type { ArtifactStore } from '../tools/artifact-store.js';
import type { RuntimeTool } from '../tools/runtime-tool.js';

/** Emits one protocol event; the host assigns event ids and sequence numbers. */
export type EmitEvent = <K extends Exclude<RuntimeEventType, `run.${string}`>>(
  type: K,
  payload: RuntimeEventPayloads[K],
  stepId?: string,
) => Promise<void>;

/**
 * Everything a kernel may use. Kernels never see transport, credentials or checkpoint storage,
 * and never emit run lifecycle events: the host owns the run lifecycle (ADR 0006).
 */
export interface KernelContext {
  correlation: RuntimeCorrelation;
  task: TaskSpec;
  manifest: SignedAgentManifestV2;
  emit: EmitEvent;
  requestAction(
    request: Omit<RuntimeActionRequest, 'protocol' | 'requestId'>,
  ): Promise<RuntimeActionDecision>;
  models: ModelGateway;
  tools: RuntimeTool[];
  artifacts: ArtifactStore;
  signal: AbortSignal;
}

export type KernelOutcome =
  | { status: 'COMPLETED'; summary: string; artifactIds: string[] }
  /** The control plane already paused the run; `state` must be JSON-serializable. */
  | { status: 'PAUSED'; approvalId: string; state: unknown }
  | { status: 'FAILED'; error: RuntimeFailure };

/**
 * The replaceable reasoning engine (ADR 0006). Kernel-specific state is opaque to the host and
 * to the control plane; only `agents-foundry/runtime/v1` events leave the runtime.
 */
export interface AgentKernel {
  readonly id: string;
  start(context: KernelContext): Promise<KernelOutcome>;
  resume(
    context: KernelContext,
    state: unknown,
    approval: { approvalId: string; decision: 'APPROVED' | 'REJECTED' },
  ): Promise<KernelOutcome>;
}
