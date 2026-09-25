import { randomUUID } from 'node:crypto';
import type {
  RunResumeCommand,
  RunSubmitCommand,
  RuntimeCorrelation,
  RuntimeEventEnvelope,
  RuntimeEventPayloads,
  RuntimeEventType,
  RuntimeLease,
  SignedAgentManifestV2,
  TaskSpec,
} from '@agents-foundry/contracts';
import { RUNTIME_PROTOCOL_V1 } from '../../../packages/contracts/src/runtime/v1/protocol.js';
import type { CheckpointStore } from './checkpoints.js';
import { ControlPlaneError, RuntimeFailure, asRuntimeFailure } from './errors.js';
import type { AgentKernel, KernelContext, KernelOutcome } from './kernel/agent-kernel.js';
import type { ManifestVerifier } from './manifest-verifier.js';
import type { ModelGateway } from './models/model-gateway.js';
import type { ArtifactStore } from './tools/artifact-store.js';
import type { ToolRegistry } from './tools/runtime-tool.js';
import type { ControlPlanePort } from './transport/control-plane-client.js';

export interface RuntimeLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Structured log lines with identifiers only: never payloads, prompts, outputs or keys. */
export const consoleLogger: RuntimeLogger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Assigns contiguous sequence numbers and delivers events in order, retrying transient errors. */
class RunEvents {
  constructor(
    private readonly port: ControlPlanePort,
    readonly correlation: RuntimeCorrelation,
    public sequence: number,
  ) {}

  async emit<K extends RuntimeEventType>(
    type: K,
    payload: RuntimeEventPayloads[K],
    stepId?: string,
  ): Promise<void> {
    const envelope = {
      protocol: RUNTIME_PROTOCOL_V1,
      eventId: randomUUID(),
      runId: this.correlation.runId,
      threadId: this.correlation.threadId,
      ...(stepId ? { stepId } : {}),
      sequence: this.sequence + 1,
      type,
      occurredAt: new Date().toISOString(),
      correlation: this.correlation,
      payload,
    } as RuntimeEventEnvelope;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.port.sendEvent(envelope);
        this.sequence += 1;
        return;
      } catch (error) {
        // Redelivery reuses the eventId, so a delivered-but-unacknowledged event is idempotent.
        if ((error instanceof ControlPlaneError && error.final) || attempt >= 4) throw error;
        await sleep(200 * 2 ** attempt);
      }
    }
  }
}

export interface RuntimeHostOptions {
  controlPlane: ControlPlanePort;
  verifier: ManifestVerifier;
  kernel: AgentKernel;
  models: ModelGateway;
  tools: ToolRegistry;
  artifacts: ArtifactStore;
  checkpoints: CheckpointStore;
  concurrency?: number;
  pollIntervalMs?: number;
  logger?: RuntimeLogger;
}

/**
 * Runtime process host: claims commands, verifies manifests, owns the run lifecycle events and
 * delegates reasoning to the kernel. Holds no organization authorization logic of its own.
 */
export class RuntimeHost {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly logger: RuntimeLogger;
  private stopped = false;

  constructor(private readonly options: RuntimeHostOptions) {
    this.logger = options.logger ?? consoleLogger;
  }

  get activeRuns(): number {
    return this.active.size;
  }

  /** Claim and start at most one command. Returns true when a command was received. */
  async pollOnce(): Promise<boolean> {
    if (this.active.size >= (this.options.concurrency ?? 4)) return false;
    const claim = await this.options.controlPlane.claim();
    if (!claim) return false;
    const { command } = claim;
    if (command.type === 'run.cancel') {
      await this.cancel(command.runId, command.reason);
      return true;
    }
    const runId = command.type === 'run.submit' ? command.run.runId : command.runId;
    if (this.active.has(runId)) return true;
    const controller = new AbortController();
    const done = (
      command.type === 'run.submit'
        ? this.submit(command, claim.lease, controller.signal)
        : this.resume(command, claim.lease, controller.signal)
    )
      .catch((error: unknown) => this.onRunError(runId, error))
      .finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, done });
    return true;
  }

  /** Wait for every run this host is executing to reach a pause or an end. */
  async drain(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((run) => run.done));
  }

  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      let received = false;
      try {
        received = await this.pollOnce();
      } catch (error) {
        this.logger.warn('claim failed', {
          code: error instanceof ControlPlaneError ? error.code : 'CLAIM_FAILED',
        });
      }
      if (!received) await sleep(this.options.pollIntervalMs ?? 2000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  private async submit(
    command: RunSubmitCommand,
    lease: RuntimeLease,
    signal: AbortSignal,
  ): Promise<void> {
    const correlation = command.correlation;
    const events = new RunEvents(this.options.controlPlane, correlation, lease.runtimeSequence);
    let manifest: SignedAgentManifestV2 | null = null;
    let failure: RuntimeFailure | null = null;
    try {
      manifest = this.options.verifier.verify(command.run.manifest, {
        correlation,
        runtimeProfile: command.run.runtimeProfile,
      });
    } catch (error) {
      failure = asRuntimeFailure(error);
    }
    await events.emit('run.started', {
      runtimeSessionId: lease.sessionId,
      kernel: this.options.kernel.id,
    });
    this.logger.info('run started', { runId: correlation.runId, kernel: this.options.kernel.id });
    if (!manifest) {
      await events.emit('run.failed', { error: failure!.toExecutionError(), retryable: false });
      return;
    }
    const context = this.context(correlation, command.run.task, manifest, events, signal);
    const outcome = await this.options.kernel.start(context);
    await this.finish(events, outcome, signal, {
      sessionId: lease.sessionId,
      task: command.run.task,
      runtimeProfile: command.run.runtimeProfile,
      manifest,
    });
  }

  private async resume(
    command: RunResumeCommand,
    lease: RuntimeLease,
    signal: AbortSignal,
  ): Promise<void> {
    const correlation = command.correlation;
    const events = new RunEvents(this.options.controlPlane, correlation, lease.runtimeSequence);
    const checkpoint = await this.options.checkpoints.load(command.runId);
    await events.emit('run.resumed', { approvalId: command.approval.approvalId });
    this.logger.info('run resumed', { runId: command.runId });
    let manifest: SignedAgentManifestV2 | null = null;
    let failure = new RuntimeFailure(
      'RUNTIME_CHECKPOINT_MISSING',
      'This runtime has no checkpoint for the paused run.',
    );
    if (checkpoint && checkpoint.approvalId === command.approval.approvalId) {
      try {
        manifest = this.options.verifier.verify(checkpoint.manifest, {
          correlation,
          runtimeProfile: checkpoint.runtimeProfile,
        });
      } catch (error) {
        failure = asRuntimeFailure(error);
      }
    }
    if (!checkpoint || !manifest || checkpoint.kernelId !== this.options.kernel.id) {
      await events.emit('run.failed', { error: failure.toExecutionError(), retryable: false });
      await this.options.checkpoints.delete(command.runId);
      return;
    }
    const context = this.context(correlation, checkpoint.task, manifest, events, signal);
    const outcome = await this.options.kernel.resume(context, checkpoint.kernelState, {
      approvalId: command.approval.approvalId,
      decision: command.approval.decision,
    });
    await this.finish(events, outcome, signal, { ...checkpoint, sessionId: lease.sessionId });
  }

  private async cancel(runId: string, reason: string): Promise<void> {
    this.active.get(runId)?.controller.abort(new RuntimeFailure('RUN_CANCELLED', reason));
    await this.options.checkpoints.delete(runId);
    this.logger.info('run cancelled', { runId });
  }

  private context(
    correlation: RuntimeCorrelation,
    task: TaskSpec,
    manifest: SignedAgentManifestV2,
    events: RunEvents,
    signal: AbortSignal,
  ): KernelContext {
    return {
      correlation,
      task,
      manifest,
      emit: (type, payload, stepId) => events.emit(type, payload, stepId),
      requestAction: (request) =>
        this.options.controlPlane.requestAction({
          ...request,
          protocol: RUNTIME_PROTOCOL_V1,
          requestId: randomUUID(),
        }),
      executeAction: (request) =>
        this.options.controlPlane.executeAction({ ...request, protocol: RUNTIME_PROTOCOL_V1 }),
      models: this.options.models,
      tools: this.options.tools.forManifest(manifest),
      artifacts: this.options.artifacts,
      signal,
    };
  }

  private async finish(
    events: RunEvents,
    outcome: KernelOutcome,
    signal: AbortSignal,
    run: {
      sessionId: string;
      task: TaskSpec;
      runtimeProfile: string;
      manifest: SignedAgentManifestV2;
    },
  ): Promise<void> {
    const correlation = events.correlation;
    const runId = correlation.runId;
    if (signal.aborted) {
      await this.options.checkpoints.delete(runId);
      return;
    }
    switch (outcome.status) {
      case 'COMPLETED':
        await events.emit('run.completed', {
          summary: outcome.summary,
          artifactIds: outcome.artifactIds,
        });
        await this.options.checkpoints.delete(runId);
        this.logger.info('run completed', { runId });
        return;
      case 'PAUSED':
        // The control plane paused the run atomically with the approval request.
        await this.options.checkpoints.save({
          version: 1,
          runId,
          sessionId: run.sessionId,
          correlation,
          task: run.task,
          runtimeProfile: run.runtimeProfile,
          manifest: run.manifest,
          kernelId: this.options.kernel.id,
          kernelState: outcome.state,
          approvalId: outcome.approvalId,
        });
        this.logger.info('run paused for approval', { runId, approvalId: outcome.approvalId });
        return;
      case 'FAILED':
        await events.emit('run.failed', {
          error: outcome.error.toExecutionError(),
          retryable: outcome.error.retryable,
        });
        await this.options.checkpoints.delete(runId);
        this.logger.warn('run failed', { runId, code: outcome.error.code });
    }
  }

  private async onRunError(runId: string, error: unknown): Promise<void> {
    // The control plane refused the run's history (for example it was cancelled); stop quietly.
    this.logger.error('run aborted', {
      runId,
      code:
        error instanceof ControlPlaneError
          ? error.code
          : error instanceof RuntimeFailure
            ? error.code
            : 'RUNTIME_INTERNAL_ERROR',
    });
    await this.options.checkpoints.delete(runId).catch(() => undefined);
  }
}
