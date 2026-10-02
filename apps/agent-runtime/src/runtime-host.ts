import { randomUUID } from 'node:crypto';
import type {
  RunRecoverCommand,
  RunResumeCommand,
  RunSubmitCommand,
  RuntimeCorrelation,
  RuntimeEventEnvelope,
  RuntimeEventPayloads,
  RuntimeEventType,
  RuntimeLease,
  SignedAgentManifestV2,
  TaskSpec,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import { RUNTIME_PROTOCOL_V1 } from '../../../packages/contracts/src/runtime/v1/protocol.js';
import {
  CheckpointConflict,
  CheckpointInvalid,
  type CheckpointStore,
  type RunCheckpoint,
} from './checkpoints.js';
import { ControlPlaneError, RuntimeFailure, asRuntimeFailure } from './errors.js';
import type { AgentKernel, KernelContext, KernelOutcome } from './kernel/agent-kernel.js';
import type { ManifestVerifier } from './manifest-verifier.js';
import type { CredentialBroker, ModelGateway, ModelUsageMeter } from './models/model-gateway.js';
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

/** What stays the same for a run across its checkpoints. */
interface RunFrame {
  sessionId: string;
  task: TaskSpec;
  workflow?: WorkflowDefinition;
  runtimeProfile: string;
  manifest: SignedAgentManifestV2;
  /** Version of the last checkpoint saved or loaded; the next save is one more. */
  checkpointVersion: number;
  /** Credentials this process resolved for the run. A checkpoint containing one is refused. */
  secrets: Set<string>;
}

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
  /**
   * Model credentials for one run (ADR 0034). When absent the gateway's own broker is used,
   * which the host cannot watch for leaks.
   */
  modelCredentials?: (correlation: RuntimeCorrelation) => CredentialBroker;
  concurrency?: number;
  pollIntervalMs?: number;
  /** How often the leases of the runs being executed are renewed. */
  heartbeatIntervalMs?: number;
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
        ? this.submit(command, claim.lease, controller)
        : this.continue(command, claim.lease, controller)
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

  /**
   * Renew the leases of the runs this host is executing, and stop any the control plane says
   * it no longer holds: another runtime has taken it over (ADR 0032).
   */
  async heartbeatOnce(): Promise<void> {
    const runIds = [...this.active.keys()];
    if (!runIds.length) return;
    const { lost } = await this.options.controlPlane.heartbeat({
      protocol: RUNTIME_PROTOCOL_V1,
      runIds,
    });
    for (const runId of lost) {
      this.active
        .get(runId)
        ?.controller.abort(new RuntimeFailure('RUNTIME_LEASE_LOST', 'The run was taken over.'));
      this.logger.warn('run lease lost', { runId });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const heartbeat = setInterval(() => {
      void this.heartbeatOnce().catch((error: unknown) =>
        this.logger.warn('heartbeat failed', {
          code: error instanceof ControlPlaneError ? error.code : 'HEARTBEAT_FAILED',
        }),
      );
    }, this.options.heartbeatIntervalMs ?? 30_000);
    try {
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
    } finally {
      clearInterval(heartbeat);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  private async submit(
    command: RunSubmitCommand,
    lease: RuntimeLease,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
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
    const { task, workflow } = command.run;
    const frame: RunFrame = {
      sessionId: lease.sessionId,
      task,
      ...(workflow ? { workflow } : {}),
      runtimeProfile: command.run.runtimeProfile,
      manifest,
      checkpointVersion: 0,
      secrets: new Set(),
    };
    const context = this.context(events, frame, controller);
    const outcome = await this.options.kernel.start(context);
    await this.finish(events, outcome, controller, frame);
  }

  /**
   * Continue a run from its latest checkpoint: after an approval (`run.resume`), or because
   * the runtime that held it stopped (`run.recover`). The checkpoint may have been written by
   * another runtime; it is used only if it verifies against the run and the pinned manifest key.
   */
  private async continue(
    command: RunResumeCommand | RunRecoverCommand,
    lease: RuntimeLease,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    const correlation = command.correlation;
    const events = new RunEvents(this.options.controlPlane, correlation, lease.runtimeSequence);
    const approval = command.type === 'run.resume' ? command.approval : null;
    let checkpoint: RunCheckpoint | null = null;
    let manifest: SignedAgentManifestV2 | null = null;
    let failure = new RuntimeFailure(
      'RUNTIME_CHECKPOINT_MISSING',
      'There is no checkpoint to continue the run from.',
    );
    try {
      checkpoint = await this.options.checkpoints.load(correlation);
    } catch (error) {
      if (!(error instanceof CheckpointInvalid)) throw error;
      failure = new RuntimeFailure(
        'RUNTIME_CHECKPOINT_INVALID',
        'The run checkpoint could not be verified.',
      );
    }
    if (approval) {
      await events.emit('run.resumed', { approvalId: approval.approvalId });
      this.logger.info('run resumed', { runId: command.runId });
    } else this.logger.info('run recovered', { runId: command.runId });
    if (checkpoint) {
      if (
        checkpoint.kernelId !== this.options.kernel.id ||
        checkpoint.runtimeSequence > lease.runtimeSequence ||
        // A recorded pause must be the one this approval answers.
        (approval && checkpoint.approvalId && checkpoint.approvalId !== approval.approvalId)
      )
        failure = new RuntimeFailure(
          'RUNTIME_CHECKPOINT_INVALID',
          'The run checkpoint does not match the run.',
        );
      else
        try {
          manifest = this.options.verifier.verify(checkpoint.manifest, {
            correlation,
            runtimeProfile: checkpoint.runtimeProfile,
          });
        } catch (error) {
          failure = asRuntimeFailure(error);
        }
    }
    if (!checkpoint || !manifest) {
      await events.emit('run.failed', { error: failure.toExecutionError(), retryable: false });
      await this.options.checkpoints.delete(command.runId);
      return;
    }
    const frame: RunFrame = {
      sessionId: lease.sessionId,
      task: checkpoint.task,
      ...(checkpoint.workflow ? { workflow: checkpoint.workflow } : {}),
      runtimeProfile: checkpoint.runtimeProfile,
      manifest,
      checkpointVersion: checkpoint.version,
      secrets: new Set(),
    };
    let recovery;
    if (command.type === 'run.recover') {
      // Steps the previous runtime left open and the checkpoint does not account for.
      for (const stepId of command.openStepIds)
        if (stepId !== checkpoint.stepId)
          await events.emit(
            'step.failed',
            {
              error: {
                code: 'RUNTIME_RECOVERED',
                message: 'The runtime stopped during this step; the run continued elsewhere.',
              },
            },
            stepId,
          );
      recovery = { openStepIds: new Set(command.openStepIds) };
    }
    const context = this.context(events, frame, controller);
    const outcome = await this.options.kernel.resume(
      context,
      checkpoint.kernelState,
      approval ? { approvalId: approval.approvalId, decision: approval.decision } : null,
      recovery,
    );
    await this.finish(events, outcome, controller, frame);
  }

  /**
   * Save the run's next checkpoint. A checkpoint that holds a credential is never written. If
   * another runtime has advanced the run, this one stops working on it.
   */
  private async checkpoint(
    events: RunEvents,
    frame: RunFrame,
    controller: AbortController,
    kernelState: unknown,
    stepId: string | null,
    approvalId: string | null,
  ): Promise<void> {
    const checkpoint: RunCheckpoint = {
      format: 2,
      version: frame.checkpointVersion + 1,
      runId: events.correlation.runId,
      sessionId: frame.sessionId,
      correlation: events.correlation,
      task: frame.task,
      ...(frame.workflow ? { workflow: frame.workflow } : {}),
      runtimeProfile: frame.runtimeProfile,
      manifest: frame.manifest,
      kernelId: this.options.kernel.id,
      kernelState,
      stepId,
      approvalId,
      runtimeSequence: events.sequence,
    };
    if (frame.secrets.size) {
      const body = JSON.stringify(checkpoint);
      for (const secret of frame.secrets)
        if (body.includes(secret))
          throw new RuntimeFailure(
            'RUNTIME_CHECKPOINT_SECRET',
            'The run state contains a credential and was not saved.',
          );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.options.checkpoints.save(checkpoint);
        frame.checkpointVersion = checkpoint.version;
        return;
      } catch (error) {
        if (error instanceof CheckpointConflict) {
          const lost = new RuntimeFailure('RUNTIME_LEASE_LOST', 'The run was taken over.');
          controller.abort(lost);
          throw lost;
        }
        if ((error instanceof ControlPlaneError && error.final) || attempt >= 3)
          throw new RuntimeFailure(
            'RUNTIME_CHECKPOINT_UNAVAILABLE',
            'The run state could not be saved.',
            true,
          );
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  private async cancel(runId: string, reason: string): Promise<void> {
    this.active.get(runId)?.controller.abort(new RuntimeFailure('RUN_CANCELLED', reason));
    await this.options.checkpoints.delete(runId);
    this.logger.info('run cancelled', { runId });
  }

  /** Reserves and settles each of the run's model calls with the control plane (ADR 0021). */
  private meter(correlation: RuntimeCorrelation): ModelUsageMeter {
    const controlPlane = this.options.controlPlane;
    return {
      async reserve(request) {
        let reservation;
        try {
          reservation = await controlPlane.reserveModelTokens({
            protocol: RUNTIME_PROTOCOL_V1,
            reservationId: randomUUID(),
            correlation,
            ...request,
          });
        } catch {
          // No decision means no call: spending limits fail closed.
          throw new RuntimeFailure(
            'MODEL_BUDGET_UNAVAILABLE',
            'The model spending limit could not be checked.',
            true,
          );
        }
        if (reservation.decision === 'DENIED')
          throw new RuntimeFailure(reservation.code, reservation.reason);
        return reservation;
      },
      async settle(reservationId, usage) {
        await controlPlane.settleModelTokens({
          protocol: RUNTIME_PROTOCOL_V1,
          reservationId,
          correlation,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      },
    };
  }

  private context(events: RunEvents, frame: RunFrame, controller: AbortController): KernelContext {
    const { correlation } = events;
    const { manifest } = frame;
    const { signal } = controller;
    const inner = this.options.modelCredentials?.(correlation);
    const credentials: CredentialBroker | undefined = inner && {
      resolve: async (scope) => {
        const credential = await inner.resolve(scope);
        frame.secrets.add(credential.apiKey);
        return credential;
      },
    };
    return {
      correlation,
      task: frame.task,
      ...(frame.workflow ? { workflow: frame.workflow } : {}),
      manifest,
      emit: (type, payload, stepId) => events.emit(type, payload, stepId),
      checkpoint: (state, stepId) =>
        this.checkpoint(events, frame, controller, state, stepId, null),
      requestAction: (request) =>
        this.options.controlPlane.requestAction({
          ...request,
          protocol: RUNTIME_PROTOCOL_V1,
          requestId: request.requestId ?? randomUUID(),
        }),
      executeAction: (request) =>
        this.options.controlPlane.executeAction({ ...request, protocol: RUNTIME_PROTOCOL_V1 }),
      requestGrant: (request) =>
        this.options.controlPlane.requestGrant({ ...request, protocol: RUNTIME_PROTOCOL_V1 }),
      models: {
        complete: (runManifest, request, runSignal) =>
          this.options.models.complete(
            runManifest,
            request,
            runSignal,
            this.meter(correlation),
            credentials,
          ),
      },
      tools: this.options.tools.forManifest(manifest),
      artifacts: this.options.artifacts,
      signal,
    };
  }

  private async finish(
    events: RunEvents,
    outcome: KernelOutcome,
    controller: AbortController,
    frame: RunFrame,
  ): Promise<void> {
    const { signal } = controller;
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
        try {
          await this.checkpoint(
            events,
            frame,
            controller,
            outcome.state,
            outcome.stepId,
            outcome.approvalId,
          );
        } catch (error) {
          // Not recorded as paused here: whoever is given the run asks for the decision again.
          this.logger.warn('pause checkpoint failed', {
            runId,
            code: asRuntimeFailure(error).code,
          });
          return;
        }
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
