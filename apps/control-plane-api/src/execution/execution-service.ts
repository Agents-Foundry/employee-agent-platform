import { createHash, randomUUID } from 'node:crypto';
import type {
  Actor,
  AgentEvent,
  AgentEventPage,
  AgentEventSource,
  AgentEventType,
  AgentRun,
  AgentRunDetail,
  AgentRunStatus,
  AnySignedAgentManifest,
  ArtifactSummary,
  ManifestReference,
  RunApprovalSummary,
  RunStep,
  RunStepKind,
  RunStepStatus,
  RunSubmitCommand,
  TaskSpec,
  Thread,
  ThreadDetail,
  AgentManifestV2Payload,
  ArtifactRegistration,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import {
  APPROVAL_GRANTED,
  APPROVAL_REJECTED,
  canTransitionRun,
  canTransitionStep,
  decideRuntimeEvent,
} from '../../../../packages/contracts/src/run-lifecycle.js';
import { canonicalManifest, manifestSubject } from '../../../../packages/contracts/src/manifest.js';
import {
  parseRuntimeCommand,
  parseRuntimeEvent,
} from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../../packages/contracts/src/runtime/v1/protocol.js';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';

export class ExecutionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LEGACY_QA_RUNTIME_PROFILE = 'legacy-qa-static-plan';
const RUNTIME_ACTOR = 'agent-runtime';

function now(): string {
  return new Date().toISOString();
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalManifest(value)).digest('hex');
}

/**
 * Identifiers are unique across organizations, but a tenant scope sees only its own rows: an
 * identifier taken by another organization surfaces as a primary-key violation instead.
 */
const DUPLICATE_IDS: Record<string, string> = {
  agent_events_pkey: 'RUNTIME_EVENT_CONFLICT',
  agent_run_steps_pkey: 'STEP_ALREADY_EXISTS',
  agent_artifacts_pkey: 'ARTIFACT_ALREADY_EXISTS',
};

export function manifestReference(manifest: AnySignedAgentManifest): ManifestReference {
  const subject = manifestSubject(manifest.payload);
  return { manifestId: subject.manifestId, apiVersion: subject.apiVersion, keyId: manifest.keyId };
}

export interface LegacyQaRunInput {
  organizationId: string;
  employeeId: string;
  agentId: string;
  conversationId: string;
  conversationTitle: string;
  qaRunId: string;
  approvalId: string;
  storyKey: string;
  targetUrl: string;
  plan: string[];
  approvalSummary: string;
  manifest: AnySignedAgentManifest | null;
}

export interface ExecutionServiceOptions {
  /**
   * Resolve a workflow from the manifest's pinned catalog bundle. Returns undefined when the
   * manifest does not grant it; the run is then never submitted (fail closed).
   */
  resolveWorkflow?: (
    manifest: AnySignedAgentManifest,
    workflowId: string,
  ) => Promise<WorkflowDefinition | undefined>;
  /**
   * Called in the same transaction when a run completes, fails or is cancelled, so anything
   * that only made sense while it ran (credential leases, ADR 0031) ends with it.
   */
  onRunStopped?: (organizationId: string, runId: string, status: AgentRunStatus) => Promise<void>;
  /**
   * Called in the same transaction before an artifact is registered, so a reference to the
   * control plane's artifact store is accepted only for bytes it holds (ADR 0033).
   */
  registerArtifact?: (
    organizationId: string,
    runId: string,
    artifact: ArtifactRegistration,
  ) => Promise<void>;
  /** Append an agent message to a conversation (caller's transaction). */
  conversationMessage?: (
    organizationId: string,
    conversationId: string,
    content: string,
  ) => Promise<void>;
}

/**
 * Tenant-scoped persistence for threads, runs, steps, events and artifacts. Every method runs
 * in its organization's tenant scope (row-level security), and every query also binds
 * `organization_id`; reads additionally enforce employee ownership. Methods join a caller's
 * open transaction or open their own.
 */
export class ExecutionService {
  constructor(
    private readonly db: PgStore,
    private readonly loadManifest: (
      agentId: string,
      organizationId: string,
      employeeId: string,
    ) => Promise<AnySignedAgentManifest>,
    private readonly options: ExecutionServiceOptions = {},
  ) {}

  /**
   * Queue a generic run for runtime pickup. The caller has already authorized the employee,
   * agent assignment and manifest.
   */
  createRun(input: {
    organizationId: string;
    employeeId: string;
    agentId: string;
    title: string;
    task: TaskSpec;
    manifest: AnySignedAgentManifest;
    threadId?: string;
    /** Run in the conversation's thread (created on first use); its outcome syncs back. */
    conversation?: { id: string; title: string };
  }): Promise<AgentRun> {
    const manifest = manifestReference(input.manifest);
    const subject = manifestSubject(input.manifest.payload);
    if (
      subject.organizationId !== input.organizationId ||
      subject.employeeId !== input.employeeId ||
      subject.agentId !== input.agentId
    )
      throw new ExecutionError(409, 'MANIFEST_INVALID');
    const runtimeProfile =
      input.manifest.payload.apiVersion === 'agents-foundry/v2'
        ? input.manifest.payload.runtime.profile
        : LEGACY_QA_RUNTIME_PROFILE;
    return this.db.tenant(input.organizationId, async () => {
      let threadId = input.threadId;
      if (threadId) {
        const thread = await this.db.get(
          `SELECT 1 FROM agent_threads WHERE id=? AND organization_id=? AND employee_id=? AND agent_id=? AND status='ACTIVE'`,
          threadId,
          input.organizationId,
          input.employeeId,
          input.agentId,
        );
        if (!thread) throw new ExecutionError(404, 'THREAD_NOT_FOUND');
        if (
          await this.db.get(
            `SELECT 1 FROM agent_runs WHERE thread_id=? AND status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')`,
            threadId,
          )
        )
          throw new ExecutionError(409, 'THREAD_HAS_ACTIVE_RUN');
      } else if (input.conversation) {
        threadId = await this.conversationThread(input, input.conversation);
      } else threadId = await this.insertThread(input, null, input.title);
      const runId = await this.insertRun({
        ...input,
        threadId,
        manifest,
        runtimeProfile,
        legacyQaRunId: null,
      });
      await this.appendEvent(
        { organizationId: input.organizationId, threadId, runId },
        'run.created',
        'CONTROL_PLANE',
        input.employeeId,
        { task: input.task, runtimeProfile },
      );
      return this.runRow(input.organizationId, runId);
    });
  }

  /** Dual-write for the legacy QA route: plan completed, execution paused for approval. */
  recordLegacyQaRun(input: LegacyQaRunInput): Promise<{
    id: string;
    threadId: string;
    status: AgentRunStatus;
  }> {
    return this.db.tenant(input.organizationId, async () => {
      const threadId = await this.threadForConversation(input);
      const task: TaskSpec = {
        objective: `Validate ${input.storyKey} against ${new URL(input.targetUrl).origin}`,
        workflow: 'validate-story',
        workItem: { system: 'issue-tracker', key: input.storyKey },
        inputs: { targetUrl: input.targetUrl },
      };
      const runId = await this.insertRun({
        organizationId: input.organizationId,
        threadId,
        employeeId: input.employeeId,
        agentId: input.agentId,
        manifest: input.manifest ? manifestReference(input.manifest) : null,
        task,
        runtimeProfile: LEGACY_QA_RUNTIME_PROFILE,
        legacyQaRunId: input.qaRunId,
      });
      const scope = { organizationId: input.organizationId, threadId, runId };
      await this.appendEvent(scope, 'run.created', 'CONTROL_PLANE', input.employeeId, {
        task,
        runtimeProfile: LEGACY_QA_RUNTIME_PROFILE,
        legacyQaRunId: input.qaRunId,
      });
      await this.transitionRun(scope, 'RUNNING', null);
      await this.appendEvent(scope, 'run.started', 'CONTROL_PLANE', null, {
        executor: 'control-plane.legacy-qa-static-plan',
      });
      const planStep = await this.insertStep(scope, 'PLAN', 'Prepare QA test plan', 'COMPLETED', {
        plan: input.plan,
      });
      await this.appendEvent(
        scope,
        'step.completed',
        'CONTROL_PLANE',
        null,
        { plan: input.plan },
        planStep,
      );
      const action = 'qa.execute_playwright';
      const actionStep = await this.insertStep(scope, 'ACTION', action, 'WAITING_FOR_APPROVAL', {
        action,
        targetOrigin: new URL(input.targetUrl).origin,
      });
      await this.db.run(
        'UPDATE approvals SET run_id=?, step_id=? WHERE id=? AND organization_id=?',
        runId,
        actionStep,
        input.approvalId,
        input.organizationId,
      );
      await this.appendEvent(
        scope,
        'approval.requested',
        'CONTROL_PLANE',
        input.employeeId,
        { approvalId: input.approvalId, action, risk: 'MEDIUM', summary: input.approvalSummary },
        actionStep,
      );
      await this.transitionRun(scope, 'WAITING_FOR_APPROVAL', 'APPROVAL_REQUIRED');
      await this.appendEvent(scope, 'run.paused', 'CONTROL_PLANE', null, {
        reason: 'APPROVAL_REQUIRED',
        approvalId: input.approvalId,
      });
      return { id: runId, threadId, status: 'WAITING_FOR_APPROVAL' as const };
    });
  }

  /**
   * Apply a human approval decision to the run it paused. Approval re-queues the run for
   * runtime pickup (`run.resume`); rejection cancels it. Unlinked approvals are ignored.
   */
  onApprovalDecided(
    organizationId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    actorId: string,
  ): Promise<void> {
    return this.db.tenant(organizationId, async () => {
      const link = await this.db.get<{ run_id: string | null; step_id: string | null }>(
        'SELECT run_id, step_id FROM approvals WHERE id=? AND organization_id=?',
        approvalId,
        organizationId,
      );
      if (!link?.run_id) return;
      const run = await this.runRow(organizationId, link.run_id);
      const scope = { organizationId, threadId: run.threadId, runId: run.id };
      const stepId = link.step_id ?? undefined;
      await this.appendEvent(
        scope,
        decision === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
        'CONTROL_PLANE',
        actorId,
        { approvalId, decidedBy: actorId },
        stepId,
      );
      if (run.status !== 'WAITING_FOR_APPROVAL') return;
      // Only a step paused for this decision moves; history on other steps never blocks a decision.
      const waitingStep =
        stepId &&
        (await this.stepRow(organizationId, run.id, stepId)).status === 'WAITING_FOR_APPROVAL'
          ? stepId
          : undefined;
      if (decision === 'APPROVED') {
        if (waitingStep) await this.transitionStep(organizationId, waitingStep, 'PENDING');
        await this.transitionRun(scope, 'QUEUED', APPROVAL_GRANTED);
      } else {
        if (waitingStep) await this.transitionStep(organizationId, waitingStep, 'CANCELLED');
        await this.transitionRun(scope, 'CANCELLED', APPROVAL_REJECTED);
        await this.appendEvent(scope, 'run.cancelled', 'CONTROL_PLANE', actorId, {
          reason: APPROVAL_REJECTED,
        });
      }
    });
  }

  /**
   * Pause a running run on a governed action that requires approval (ADR 0005, ADR 0011).
   * The approval row already exists in the caller's transaction; the step and run move to
   * WAITING_FOR_APPROVAL atomically with it, so no decision can race the pause.
   */
  pauseForApproval(
    organizationId: string,
    runId: string,
    stepId: string,
    approval: { id: string; action: string; risk: string; summary: string },
  ): Promise<void> {
    return this.db.tenant(organizationId, async () => {
      const run = await this.runRow(organizationId, runId);
      if (run.status !== 'RUNNING') throw new ExecutionError(409, 'RUN_NOT_RUNNING');
      const scope = { organizationId, threadId: run.threadId, runId };
      const step = await this.stepRow(organizationId, runId, stepId);
      await this.transitionStep(organizationId, step.id, 'WAITING_FOR_APPROVAL');
      await this.appendEvent(
        scope,
        'approval.requested',
        'CONTROL_PLANE',
        run.agentId,
        {
          approvalId: approval.id,
          action: approval.action,
          risk: approval.risk,
          summary: approval.summary,
        },
        step.id,
      );
      await this.transitionRun(scope, 'WAITING_FOR_APPROVAL', 'APPROVAL_REQUIRED');
      await this.appendEvent(scope, 'run.paused', 'CONTROL_PLANE', null, {
        reason: 'APPROVAL_REQUIRED',
        approvalId: approval.id,
      });
      await this.syncConversation(
        scope,
        `Waiting for approval ${approval.id.slice(0, 8)}: ${approval.summary}`,
      );
    });
  }

  /** Cancel a non-terminal run; a runtime holding it receives `run.cancel` on its next claim. */
  cancelRun(
    organizationId: string,
    runId: string,
    reason: string,
    actorId: string | null,
  ): Promise<AgentRun> {
    return this.db.tenant(organizationId, async () => {
      const run = await this.runRow(organizationId, runId);
      if (!canTransitionRun(run.status, 'CANCELLED')) throw new ExecutionError(409, 'RUN_TERMINAL');
      const scope = { organizationId, threadId: run.threadId, runId };
      const open = await this.db.all<{ id: string }>(
        `SELECT id FROM agent_run_steps WHERE run_id=? AND organization_id=?
         AND status IN ('PENDING','RUNNING','WAITING_FOR_APPROVAL') ORDER BY sequence`,
        runId,
        organizationId,
      );
      for (const step of open) await this.transitionStep(organizationId, step.id, 'CANCELLED');
      await this.transitionRun(scope, 'CANCELLED', reason);
      await this.appendEvent(scope, 'run.cancelled', 'CONTROL_PLANE', actorId, { reason });
      await this.syncConversation(scope, `The run was cancelled (${reason}).`);
      return this.mapRun(
        (await this.db.get(
          'SELECT * FROM agent_runs WHERE id=? AND organization_id=?',
          runId,
          organizationId,
        ))!,
      );
    });
  }

  /** The owning employee cancels their own run. */
  cancelOwnRun(actor: Actor, runId: string): Promise<AgentRun> {
    return this.db.tenant(actor.organizationId, async () => {
      const run = await this.readableRun(actor, runId, false);
      return this.cancelRun(actor.organizationId, run.id, 'CANCELLED_BY_EMPLOYEE', actor.id);
    });
  }

  /** Employee-facing run view (no runtime bookkeeping). */
  getOwnRun(actor: Actor, runId: string): Promise<AgentRun> {
    return this.db.tenant(actor.organizationId, () => this.readableRun(actor, runId, false));
  }

  /** An approval expired unused: the run it paused is cancelled (fail closed, ADR 0012). */
  onApprovalExpired(organizationId: string, approvalId: string): Promise<void> {
    return this.db.tenant(organizationId, async () => {
      const link = await this.db.get<{ run_id: string | null; step_id: string | null }>(
        'SELECT run_id, step_id FROM approvals WHERE id=? AND organization_id=?',
        approvalId,
        organizationId,
      );
      if (!link?.run_id) return;
      const run = await this.runRow(organizationId, link.run_id);
      const scope = { organizationId, threadId: run.threadId, runId: run.id };
      await this.appendEvent(
        scope,
        'approval.expired',
        'CONTROL_PLANE',
        null,
        { approvalId },
        link.step_id ?? undefined,
      );
      if (run.status === 'WAITING_FOR_APPROVAL')
        await this.cancelRun(organizationId, run.id, 'APPROVAL_EXPIRED', null);
    });
  }

  /**
   * Validate and record one runtime-emitted event (agents-foundry/runtime/v1).
   * The caller must authenticate the runtime and supply the tenant it is authorized for.
   */
  async ingestRuntimeEvent(
    organizationId: string,
    input: unknown,
  ): Promise<{ event: AgentEvent; duplicate: boolean }> {
    const envelope = parseRuntimeEvent(input);
    if (envelope.correlation.organizationId !== organizationId)
      throw new ExecutionError(403, 'RUNTIME_TENANT_FORBIDDEN');
    const payloadHash = sha256({
      type: envelope.type,
      runId: envelope.runId,
      stepId: envelope.stepId ?? null,
      sequence: envelope.sequence,
      occurredAt: envelope.occurredAt,
      payload: envelope.payload,
    });
    try {
      return await this.db.tenant(organizationId, () =>
        this.recordRuntimeEvent(organizationId, envelope, payloadHash),
      );
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraintKind(error) === 'unique' && constraint && DUPLICATE_IDS[constraint])
        throw new ExecutionError(409, DUPLICATE_IDS[constraint]);
      throw error;
    }
  }

  private async recordRuntimeEvent(
    organizationId: string,
    envelope: ReturnType<typeof parseRuntimeEvent>,
    payloadHash: string,
  ): Promise<{ event: AgentEvent; duplicate: boolean }> {
    const existing = await this.db.get(
      'SELECT * FROM agent_events WHERE id=? AND organization_id=?',
      envelope.eventId,
      organizationId,
    );
    if (existing) {
      if (existing['payload_hash'] !== payloadHash)
        throw new ExecutionError(409, 'RUNTIME_EVENT_CONFLICT');
      return { event: this.mapEvent(existing), duplicate: true };
    }
    const run = await this.runRow(organizationId, envelope.runId);
    const { correlation } = envelope;
    if (
      run.threadId !== envelope.threadId ||
      run.employeeId !== correlation.employeeId ||
      run.agentId !== correlation.agentId
    )
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    if (envelope.sequence !== run.runtimeSequence + 1)
      throw new ExecutionError(409, 'RUNTIME_EVENT_OUT_OF_ORDER');
    const decision = decideRuntimeEvent(run, envelope.type);
    if (!decision.accepted) throw new ExecutionError(409, decision.code);
    const scope = { organizationId, threadId: run.threadId, runId: run.id };
    const stepId = envelope.stepId;
    if (envelope.type === 'run.resumed') {
      // The runtime must name the approval that released the run; the approved step restarts.
      const approval = await this.db.get<{ step_id: string | null }>(
        `SELECT step_id FROM approvals WHERE id=? AND organization_id=? AND run_id=? AND status='APPROVED'`,
        envelope.payload.approvalId,
        organizationId,
        run.id,
      );
      if (!approval) throw new ExecutionError(409, 'RUNTIME_APPROVAL_MISMATCH');
      if (
        approval.step_id &&
        (await this.stepRow(organizationId, run.id, approval.step_id)).status === 'PENDING'
      )
        await this.transitionStep(organizationId, approval.step_id, 'RUNNING');
    }
    if (envelope.type === 'step.started') {
      if (await this.db.get('SELECT 1 FROM agent_run_steps WHERE id=?', stepId!))
        throw new ExecutionError(409, 'STEP_ALREADY_EXISTS');
      await this.insertStep(
        scope,
        envelope.payload.kind,
        envelope.payload.title,
        'RUNNING',
        {},
        stepId,
      );
    } else if (stepId) {
      const step = await this.stepRow(organizationId, run.id, stepId);
      if (envelope.type === 'step.completed' || envelope.type === 'step.failed')
        await this.transitionStep(
          organizationId,
          step.id,
          envelope.type === 'step.completed' ? 'COMPLETED' : 'FAILED',
        );
    }
    if (envelope.type === 'artifact.created') {
      const artifact = envelope.payload.artifact;
      if (await this.db.get('SELECT 1 FROM agent_artifacts WHERE id=?', artifact.id))
        throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
      await this.options.registerArtifact?.(organizationId, run.id, artifact);
      await this.db.run(
        `INSERT INTO agent_artifacts (id,organization_id,thread_id,run_id,step_id,artifact_type,media_type,name,
         storage_reference,checksum_sha256,size_bytes,retention_policy,created_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        artifact.id,
        organizationId,
        run.threadId,
        run.id,
        stepId ?? null,
        artifact.type,
        artifact.mediaType,
        artifact.name,
        artifact.storageReference,
        artifact.checksum.value,
        artifact.sizeBytes,
        artifact.retentionPolicy,
        now(),
        RUNTIME_ACTOR,
      );
    }
    const reason =
      envelope.type === 'run.paused'
        ? envelope.payload.reason
        : envelope.type === 'run.failed'
          ? envelope.payload.error.code
          : envelope.type === 'run.cancelled'
            ? envelope.payload.reason
            : null;
    // Record the sequence before any terminal transition; terminal runs are immutable.
    await this.db.run(
      'UPDATE agent_runs SET runtime_sequence=?, updated_at=? WHERE id=? AND organization_id=?',
      envelope.sequence,
      now(),
      run.id,
      organizationId,
    );
    if (decision.nextStatus !== run.status)
      await this.transitionRun(scope, decision.nextStatus, reason);
    // Artifacts are referenced by id in the event; the storage reference stays out of history.
    const payload =
      envelope.type === 'artifact.created'
        ? { artifactId: envelope.payload.artifact.id, type: envelope.payload.artifact.type }
        : envelope.payload;
    const id = await this.appendEvent(
      scope,
      envelope.type,
      'RUNTIME',
      RUNTIME_ACTOR,
      payload,
      stepId,
      {
        id: envelope.eventId,
        runtimeSequence: envelope.sequence,
        occurredAt: envelope.occurredAt,
        payloadHash,
      },
    );
    if (envelope.type === 'run.completed')
      await this.syncConversation(scope, envelope.payload.summary);
    else if (envelope.type === 'run.failed')
      await this.syncConversation(
        scope,
        `The run failed: ${envelope.payload.error.code}. ${envelope.payload.error.message}`,
      );
    else if (envelope.type === 'run.cancelled')
      await this.syncConversation(scope, `The run was cancelled (${envelope.payload.reason}).`);
    return {
      event: this.mapEvent((await this.db.get('SELECT * FROM agent_events WHERE id=?', id))!),
      duplicate: false,
    };
  }

  /**
   * What a checkpoint of this run must be bound to (ADR 0032): the run's identity and state,
   * and the manifest it runs under, which must still be the agent's current one.
   */
  runBinding(
    organizationId: string,
    runId: string,
  ): Promise<{
    threadId: string;
    employeeId: string;
    agentId: string;
    status: AgentRunStatus;
    runtimeSequence: number;
    workflow: string | null;
    manifestId: string;
    manifestDigest: string;
    /** The model selection the signed manifest pins. */
    model: { provider: string; credentialMode: string };
  }> {
    return this.db.tenant(organizationId, async () => {
      const run = await this.runRow(organizationId, runId);
      if (!run.manifest || run.manifest.apiVersion !== 'agents-foundry/v2')
        throw new ExecutionError(409, 'MANIFEST_INVALID');
      let manifest: AnySignedAgentManifest;
      try {
        manifest = await this.loadManifest(run.agentId, organizationId, run.employeeId);
      } catch {
        throw new ExecutionError(409, 'MANIFEST_INVALID');
      }
      if (manifestSubject(manifest.payload).manifestId !== run.manifest.manifestId)
        throw new ExecutionError(409, 'MANIFEST_INVALID');
      return {
        threadId: run.threadId,
        employeeId: run.employeeId,
        agentId: run.agentId,
        status: run.status,
        runtimeSequence: run.runtimeSequence,
        workflow: run.task.workflow ?? null,
        manifestId: run.manifest.manifestId,
        manifestDigest: sha256(manifest.payload),
        model: {
          provider: (manifest.payload as AgentManifestV2Payload).model.provider,
          credentialMode: (manifest.payload as AgentManifestV2Payload).model.credentialMode,
        },
      };
    });
  }

  /** Steps of a run that are still in progress, oldest first. */
  openSteps(organizationId: string, runId: string): Promise<string[]> {
    return this.db.tenant(organizationId, async () =>
      (
        await this.db.all<{ id: string }>(
          `SELECT id FROM agent_run_steps WHERE run_id=? AND organization_id=? AND status='RUNNING'
           ORDER BY sequence`,
          runId,
          organizationId,
        )
      ).map((step) => step.id),
    );
  }

  /** Build the `run.submit` command for a queued run. Only v2 manifests can be executed. */
  buildRunSubmitCommand(organizationId: string, runId: string): Promise<RunSubmitCommand> {
    return this.db.tenant(organizationId, async () => {
      const run = await this.runRow(organizationId, runId);
      if (run.status !== 'QUEUED' || run.statusReason !== null)
        throw new ExecutionError(409, 'RUN_NOT_SUBMITTABLE');
      if (!run.manifest || run.manifest.apiVersion !== 'agents-foundry/v2')
        throw new ExecutionError(409, 'RUNTIME_MANIFEST_V2_REQUIRED');
      const manifest = await this.loadManifest(run.agentId, organizationId, run.employeeId);
      if (
        manifest.payload.apiVersion !== 'agents-foundry/v2' ||
        manifest.payload.metadata.manifestId !== run.manifest.manifestId
      )
        throw new ExecutionError(409, 'MANIFEST_INVALID');
      let workflow: WorkflowDefinition | undefined;
      if (run.task.workflow) {
        workflow = manifest.payload.workflows.includes(run.task.workflow)
          ? await this.options.resolveWorkflow?.(manifest, run.task.workflow)
          : undefined;
        if (!workflow) throw new ExecutionError(409, 'MANIFEST_INVALID');
      }
      return parseRuntimeCommand({
        protocol: RUNTIME_PROTOCOL_V1,
        type: 'run.submit',
        commandId: randomUUID(),
        issuedAt: now(),
        correlation: {
          organizationId,
          employeeId: run.employeeId,
          agentId: run.agentId,
          threadId: run.threadId,
          runId: run.id,
        },
        run: {
          runId: run.id,
          threadId: run.threadId,
          task: run.task,
          runtimeProfile: run.runtimeProfile,
          manifest,
          workspace: null,
          ...(workflow ? { workflow } : {}),
        },
      }) as RunSubmitCommand;
    });
  }

  getThread(actor: Actor, threadId: string): Promise<ThreadDetail> {
    return this.db.tenant(actor.organizationId, async () => {
      const row = await this.db.get(
        'SELECT * FROM agent_threads WHERE id=? AND organization_id=?',
        threadId,
        actor.organizationId,
      );
      if (!row || row['employee_id'] !== actor.id)
        throw new ExecutionError(404, 'THREAD_NOT_FOUND');
      const runs = await this.db.all(
        'SELECT * FROM agent_runs WHERE thread_id=? AND organization_id=? ORDER BY created_at, seq',
        threadId,
        actor.organizationId,
      );
      return { thread: this.mapThread(row), runs: runs.map((run) => this.mapRun(run)) };
    });
  }

  /** Run governance view: the owning employee, or an administrator of the same organization. */
  getRun(actor: Actor, runId: string): Promise<AgentRunDetail> {
    return this.db.tenant(actor.organizationId, async () => {
      const run = await this.readableRun(actor, runId, true);
      const steps = await this.db.all(
        'SELECT * FROM agent_run_steps WHERE run_id=? AND organization_id=? ORDER BY sequence',
        run.id,
        actor.organizationId,
      );
      const approvals = await this.db.all(
        `SELECT id, action, risk, status, step_id, created_at, decided_at, expires_at FROM approvals
         WHERE run_id=? AND organization_id=? ORDER BY created_at, seq`,
        run.id,
        actor.organizationId,
      );
      const artifacts = await this.db.all(
        `SELECT a.*, o.state AS object_state, o.expires_at AS object_expires_at,
          o.deleted_at AS object_deleted_at, o.deletion_reason AS object_deletion_reason
         FROM agent_artifacts a
         LEFT JOIN agent_artifact_objects o
          ON o.artifact_id=a.id AND o.organization_id=a.organization_id
         WHERE a.run_id=? AND a.organization_id=? ORDER BY a.created_at, a.seq`,
        run.id,
        actor.organizationId,
      );
      return {
        run,
        steps: steps.map((step) => this.mapStep(step)),
        approvals: approvals.map((row): RunApprovalSummary => ({
          id: String(row['id']),
          action: String(row['action']),
          risk: String(row['risk']) as RunApprovalSummary['risk'],
          status: String(row['status']) as RunApprovalSummary['status'],
          stepId: row['step_id'] === null ? null : String(row['step_id']),
          createdAt: String(row['created_at']),
          ...(row['decided_at'] ? { decidedAt: String(row['decided_at']) } : {}),
          ...(row['expires_at'] ? { expiresAt: String(row['expires_at']) } : {}),
        })),
        artifacts: artifacts.map((row) => this.mapArtifact(row)),
      };
    });
  }

  /** An artifact of a run `actor` may read: the owning employee or an administrator. */
  readableArtifact(
    actor: Actor,
    artifactId: string,
  ): Promise<{ id: string; runId: string; name: string; mediaType: string }> {
    return this.db.tenant(actor.organizationId, async () => {
      const row = await this.db.get(
        'SELECT id, run_id, name, media_type FROM agent_artifacts WHERE id=? AND organization_id=?',
        artifactId,
        actor.organizationId,
      );
      if (!row) throw new ExecutionError(404, 'ARTIFACT_NOT_FOUND');
      try {
        await this.readableRun(actor, String(row['run_id']), true);
      } catch {
        throw new ExecutionError(404, 'ARTIFACT_NOT_FOUND');
      }
      return {
        id: String(row['id']),
        runId: String(row['run_id']),
        name: String(row['name']),
        mediaType: String(row['media_type']),
      };
    });
  }

  /** Event history is conversation-grade content: only the owning employee may read it. */
  listEvents(
    actor: Actor,
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<AgentEventPage> {
    return this.db.tenant(actor.organizationId, async () => {
      const run = await this.readableRun(actor, runId, false);
      const rows = await this.db.all(
        'SELECT * FROM agent_events WHERE run_id=? AND organization_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        run.id,
        actor.organizationId,
        afterSequence,
        limit,
      );
      const items = rows.map((row) => this.mapEvent(row));
      return { items, nextAfterSequence: items.at(-1)?.sequence ?? afterSequence };
    });
  }

  private async readableRun(actor: Actor, runId: string, allowAdmin: boolean): Promise<AgentRun> {
    const row = await this.db.get(
      'SELECT * FROM agent_runs WHERE id=? AND organization_id=?',
      runId,
      actor.organizationId,
    );
    if (!row || (row['employee_id'] !== actor.id && !(allowAdmin && actor.role === 'ADMIN')))
      throw new ExecutionError(404, 'RUN_NOT_FOUND');
    return this.mapRun(row);
  }

  /**
   * The conversation's thread for a generic run. One thread per conversation keeps the
   * execution workspace (which is per thread); a thread with an active run is refused.
   */
  private async conversationThread(
    owner: { organizationId: string; employeeId: string; agentId: string },
    conversation: { id: string; title: string },
  ): Promise<string> {
    const thread = await this.db.get<{ id: string }>(
      `SELECT id FROM agent_threads WHERE organization_id=? AND conversation_id=? AND agent_id=? AND employee_id=?
       AND status='ACTIVE' ORDER BY updated_at DESC, seq DESC LIMIT 1`,
      owner.organizationId,
      conversation.id,
      owner.agentId,
      owner.employeeId,
    );
    if (!thread) return this.insertThread(owner, conversation.id, conversation.title);
    if (
      await this.db.get(
        `SELECT 1 FROM agent_runs WHERE thread_id=? AND status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')`,
        thread.id,
      )
    )
      throw new ExecutionError(409, 'THREAD_HAS_ACTIVE_RUN');
    await this.db.run('UPDATE agent_threads SET updated_at=? WHERE id=?', now(), thread.id);
    return thread.id;
  }

  /** Mirror a generic run's outcome into its conversation (conversationSync: REQUIRED). */
  private async syncConversation(
    scope: { organizationId: string; threadId: string; runId: string },
    content: string,
  ): Promise<void> {
    if (!this.options.conversationMessage) return;
    const link = await this.db.get<{ conversation_id: string | null }>(
      `SELECT t.conversation_id FROM agent_threads t JOIN agent_runs r ON r.thread_id=t.id
       WHERE r.id=? AND r.organization_id=? AND r.legacy_qa_run_id IS NULL`,
      scope.runId,
      scope.organizationId,
    );
    if (!link?.conversation_id) return;
    await this.options.conversationMessage(
      scope.organizationId,
      link.conversation_id,
      content.slice(0, 20_000),
    );
  }

  private async threadForConversation(input: LegacyQaRunInput): Promise<string> {
    const idle = await this.db.get<{ id: string }>(
      `SELECT t.id FROM agent_threads t WHERE t.organization_id=? AND t.conversation_id=? AND t.agent_id=?
       AND t.employee_id=? AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.thread_id=t.id
       AND r.status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')) ORDER BY t.updated_at DESC, t.seq DESC LIMIT 1`,
      input.organizationId,
      input.conversationId,
      input.agentId,
      input.employeeId,
    );
    if (idle) {
      await this.db.run('UPDATE agent_threads SET updated_at=? WHERE id=?', now(), idle.id);
      return idle.id;
    }
    return this.insertThread(input, input.conversationId, input.conversationTitle);
  }

  private async insertThread(
    owner: { organizationId: string; employeeId: string; agentId: string },
    conversationId: string | null,
    title: string,
  ): Promise<string> {
    const id = randomUUID();
    const timestamp = now();
    await this.db.run(
      `INSERT INTO agent_threads (id,organization_id,employee_id,agent_id,conversation_id,title,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'ACTIVE',?,?)`,
      id,
      owner.organizationId,
      owner.employeeId,
      owner.agentId,
      conversationId,
      title.trim().slice(0, 200) || 'Agent thread',
      timestamp,
      timestamp,
    );
    return id;
  }

  private async insertRun(input: {
    organizationId: string;
    threadId: string;
    employeeId: string;
    agentId: string;
    manifest: ManifestReference | null;
    task: TaskSpec;
    runtimeProfile: string;
    legacyQaRunId: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const timestamp = now();
    await this.db.run(
      `INSERT INTO agent_runs (id,organization_id,thread_id,employee_id,agent_id,manifest_id,manifest_api_version,
       manifest_key_id,task,runtime_profile,status,legacy_qa_run_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?)`,
      id,
      input.organizationId,
      input.threadId,
      input.employeeId,
      input.agentId,
      input.manifest?.manifestId ?? null,
      input.manifest?.apiVersion ?? null,
      input.manifest?.keyId ?? null,
      JSON.stringify(input.task),
      input.runtimeProfile,
      input.legacyQaRunId,
      timestamp,
      timestamp,
    );
    return id;
  }

  private async insertStep(
    scope: { organizationId: string; runId: string },
    kind: RunStepKind,
    title: string,
    status: RunStepStatus,
    detail: Record<string, unknown>,
    id: string = randomUUID(),
  ): Promise<string> {
    const timestamp = now();
    const { next } = (await this.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_run_steps WHERE run_id=?',
      scope.runId,
    ))!;
    await this.db.run(
      `INSERT INTO agent_run_steps (id,organization_id,run_id,sequence,kind,title,status,detail,created_at,started_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      scope.organizationId,
      scope.runId,
      next,
      kind,
      title,
      status,
      JSON.stringify(detail),
      timestamp,
      status === 'PENDING' ? null : timestamp,
      ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(status) ? timestamp : null,
    );
    return id;
  }

  private async appendEvent(
    scope: { organizationId: string; threadId: string; runId: string },
    type: AgentEventType,
    source: AgentEventSource,
    actorId: string | null,
    payload: object,
    stepId?: string,
    runtime?: { id: string; runtimeSequence: number; occurredAt: string; payloadHash: string },
  ): Promise<string> {
    const id = runtime?.id ?? randomUUID();
    const recordedAt = now();
    const { next } = (await this.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_events WHERE run_id=?',
      scope.runId,
    ))!;
    await this.db.run(
      `INSERT INTO agent_events (id,organization_id,thread_id,run_id,step_id,sequence,runtime_sequence,event_type,source,
       actor_id,payload,payload_hash,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      scope.organizationId,
      scope.threadId,
      scope.runId,
      stepId ?? null,
      next,
      runtime?.runtimeSequence ?? null,
      type,
      source,
      actorId,
      JSON.stringify(payload),
      runtime?.payloadHash ?? sha256(payload),
      runtime?.occurredAt ?? recordedAt,
      recordedAt,
    );
    return id;
  }

  private async transitionRun(
    scope: { organizationId: string; runId: string },
    to: AgentRunStatus,
    reason: string | null,
  ): Promise<void> {
    const run = await this.runRow(scope.organizationId, scope.runId);
    if (run.status !== to && !canTransitionRun(run.status, to))
      throw new ExecutionError(409, 'ILLEGAL_RUN_TRANSITION');
    const timestamp = now();
    await this.db.run(
      `UPDATE agent_runs SET status=?, status_reason=?, updated_at=?,
       started_at=COALESCE(started_at, CASE WHEN ?::text='RUNNING' THEN ?::timestamptz END),
       completed_at=CASE WHEN ?::text IN ('COMPLETED','FAILED','CANCELLED') THEN ?::timestamptz ELSE completed_at END
       WHERE id=? AND organization_id=?`,
      to,
      reason,
      timestamp,
      to,
      timestamp,
      to,
      timestamp,
      scope.runId,
      scope.organizationId,
    );
    if (run.status !== to && (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED'))
      await this.options.onRunStopped?.(scope.organizationId, scope.runId, to);
  }

  private async transitionStep(
    organizationId: string,
    stepId: string,
    to: RunStepStatus,
  ): Promise<void> {
    const row = await this.db.get<{ status: RunStepStatus }>(
      'SELECT status FROM agent_run_steps WHERE id=? AND organization_id=?',
      stepId,
      organizationId,
    );
    if (!row) throw new ExecutionError(404, 'STEP_NOT_FOUND');
    if (!canTransitionStep(row.status, to))
      throw new ExecutionError(409, 'ILLEGAL_STEP_TRANSITION');
    const timestamp = now();
    await this.db.run(
      `UPDATE agent_run_steps SET status=?,
       completed_at=CASE WHEN ?::text IN ('COMPLETED','FAILED','SKIPPED','CANCELLED') THEN ?::timestamptz ELSE completed_at END
       WHERE id=? AND organization_id=?`,
      to,
      to,
      timestamp,
      stepId,
      organizationId,
    );
  }

  private async runRow(organizationId: string, runId: string) {
    const row = await this.db.get(
      'SELECT * FROM agent_runs WHERE id=? AND organization_id=?',
      runId,
      organizationId,
    );
    if (!row) throw new ExecutionError(404, 'RUN_NOT_FOUND');
    return { ...this.mapRun(row), runtimeSequence: Number(row['runtime_sequence']) };
  }

  private async stepRow(organizationId: string, runId: string, stepId: string): Promise<RunStep> {
    const row = await this.db.get(
      'SELECT * FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?',
      stepId,
      runId,
      organizationId,
    );
    if (!row) throw new ExecutionError(404, 'STEP_NOT_FOUND');
    return this.mapStep(row);
  }

  private mapThread(row: Row): Thread {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      employeeId: String(row['employee_id']),
      agentId: String(row['agent_id']),
      conversationId: row['conversation_id'] === null ? null : String(row['conversation_id']),
      title: String(row['title']),
      status: String(row['status']) as Thread['status'],
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private mapRun(row: Row): AgentRun {
    const optional = (key: string) => (row[key] === null ? null : String(row[key]));
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      threadId: String(row['thread_id']),
      employeeId: String(row['employee_id']),
      agentId: String(row['agent_id']),
      manifest:
        row['manifest_id'] === null
          ? null
          : {
              manifestId: String(row['manifest_id']),
              apiVersion: String(row['manifest_api_version']) as ManifestReference['apiVersion'],
              keyId: String(row['manifest_key_id']),
            },
      task: JSON.parse(String(row['task'])) as TaskSpec,
      runtimeProfile: String(row['runtime_profile']),
      status: String(row['status']) as AgentRunStatus,
      statusReason: optional('status_reason'),
      legacyQaRunId: optional('legacy_qa_run_id'),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
      startedAt: optional('started_at'),
      completedAt: optional('completed_at'),
    };
  }

  private mapStep(row: Row): RunStep {
    const optional = (key: string) => (row[key] === null ? null : String(row[key]));
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      runId: String(row['run_id']),
      sequence: Number(row['sequence']),
      kind: String(row['kind']) as RunStepKind,
      title: String(row['title']),
      status: String(row['status']) as RunStepStatus,
      detail: JSON.parse(String(row['detail'])) as Record<string, unknown>,
      createdAt: String(row['created_at']),
      startedAt: optional('started_at'),
      completedAt: optional('completed_at'),
    };
  }

  private mapEvent(row: Row): AgentEvent {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      threadId: String(row['thread_id']),
      runId: String(row['run_id']),
      stepId: row['step_id'] === null ? null : String(row['step_id']),
      sequence: Number(row['sequence']),
      type: String(row['event_type']) as AgentEventType,
      source: String(row['source']) as AgentEventSource,
      actorId: row['actor_id'] === null ? null : String(row['actor_id']),
      payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
      occurredAt: String(row['occurred_at']),
      recordedAt: String(row['recorded_at']),
    };
  }

  private mapArtifact(row: Row): ArtifactSummary {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      threadId: String(row['thread_id']),
      runId: String(row['run_id']),
      stepId: row['step_id'] === null ? null : String(row['step_id']),
      type: String(row['artifact_type']) as ArtifactSummary['type'],
      mediaType: String(row['media_type']),
      name: String(row['name']),
      checksum: { algorithm: 'sha256', value: String(row['checksum_sha256']) },
      sizeBytes: Number(row['size_bytes']),
      retentionPolicy: String(row['retention_policy']) as ArtifactSummary['retentionPolicy'],
      createdAt: String(row['created_at']),
      createdBy: String(row['created_by']),
      content: {
        state:
          row['object_state'] === 'REGISTERED'
            ? 'AVAILABLE'
            : row['object_state'] === 'DELETED'
              ? 'DELETED'
              : 'UNMANAGED',
        expiresAt: row['object_expires_at'] ? String(row['object_expires_at']) : null,
        deletedAt: row['object_deleted_at'] ? String(row['object_deleted_at']) : null,
        deletionReason: row['object_deletion_reason']
          ? String(row['object_deletion_reason'])
          : null,
      },
    };
  }
}
