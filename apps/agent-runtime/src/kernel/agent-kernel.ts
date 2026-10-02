import type {
  RuntimeActionDecision,
  RuntimeActionExecuteRequest,
  RuntimeActionExecution,
  RuntimeActionRequest,
  RuntimeCorrelation,
  RuntimeEventPayloads,
  RuntimeEventType,
  SignedAgentManifestV2,
  SignedExecutionGrant,
  TaskSpec,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import type { RuntimeFailure } from '../errors.js';
import type { RunModels } from '../models/model-gateway.js';
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
  /** The task's workflow, resolved by the control plane from the pinned catalog (guidance). */
  workflow?: WorkflowDefinition;
  manifest: SignedAgentManifestV2;
  emit: EmitEvent;
  /**
   * `requestId` is the idempotency key. A kernel that checkpoints it before asking gets the
   * same decision again after a recovery, instead of a second request.
   */
  requestAction(
    request: Omit<RuntimeActionRequest, 'protocol' | 'requestId'> & { requestId?: string },
  ): Promise<RuntimeActionDecision>;
  /** Execute a control-plane-owned action that was allowed or approved (single use). */
  executeAction(
    request: Omit<RuntimeActionExecuteRequest, 'protocol'>,
  ): Promise<RuntimeActionExecution>;
  /** Obtain the signed execution grant for an allowed or approved execution-runtime action. */
  requestGrant(
    request: Omit<RuntimeActionExecuteRequest, 'protocol'>,
  ): Promise<SignedExecutionGrant>;
  /** Metered against the organization's model spending limits by the host (ADR 0021). */
  models: RunModels;
  tools: RuntimeTool[];
  artifacts: ArtifactStore;
  /**
   * Save the kernel's state so another runtime could continue from here (ADR 0032). `stepId`
   * names the step in progress, if any. `state` must be JSON-serializable.
   */
  checkpoint(state: unknown, stepId: string | null): Promise<void>;
  signal: AbortSignal;
}

/** Given to `resume` when the run is continued after its runtime stopped. */
export interface KernelRecovery {
  /** Steps the control plane still holds open. */
  openStepIds: ReadonlySet<string>;
}

export type KernelOutcome =
  | { status: 'COMPLETED'; summary: string; artifactIds: string[] }
  /** The control plane already paused the run; `state` must be JSON-serializable. */
  | { status: 'PAUSED'; approvalId: string; stepId: string; state: unknown }
  | { status: 'FAILED'; error: RuntimeFailure };

/**
 * The replaceable reasoning engine (ADR 0006). Kernel-specific state is opaque to the host and
 * to the control plane; only `agents-foundry/runtime/v1` events leave the runtime.
 */
export interface AgentKernel {
  readonly id: string;
  start(context: KernelContext): Promise<KernelOutcome>;
  /**
   * Continue from checkpointed state: after an approval decision, after the runtime that held
   * the run stopped (`recovery`), or both. Work the state records as done is not repeated.
   */
  resume(
    context: KernelContext,
    state: unknown,
    approval: { approvalId: string; decision: 'APPROVED' | 'REJECTED' } | null,
    recovery?: KernelRecovery,
  ): Promise<KernelOutcome>;
}
