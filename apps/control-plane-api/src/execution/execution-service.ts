import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
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

export class ExecutionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, SQLInputValue>;
const LEGACY_QA_RUNTIME_PROFILE = 'legacy-qa-static-plan';
const RUNTIME_ACTOR = 'agent-runtime';

function now(): string {
  return new Date().toISOString();
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalManifest(value)).digest('hex');
}

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
  ) => WorkflowDefinition | undefined;
  /** Append an agent message to a conversation (caller's transaction). */
  conversationMessage?: (organizationId: string, conversationId: string, content: string) => void;
}

/**
 * Tenant-scoped persistence for threads, runs, steps, events and artifacts.
 * Every query binds `organization_id`; reads additionally enforce employee ownership.
 * Methods compose into a caller's open transaction or open their own.
 */
export class ExecutionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly loadManifest: (
      agentId: string,
      organizationId: string,
      employeeId: string,
    ) => AnySignedAgentManifest,
    private readonly options: ExecutionServiceOptions = {},
  ) {}

  /**
   * Queue a generic run for runtime pickup. The caller has already authorized the employee,
   * agent assignment and manifest. No HTTP route calls this until a runtime exists (Phase C).
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
  }): AgentRun {
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
    return this.transaction(() => {
      let threadId = input.threadId;
      if (threadId) {
        const thread = this.db
          .prepare(
            `SELECT 1 FROM agent_threads WHERE id=? AND organization_id=? AND employee_id=? AND agent_id=? AND status='ACTIVE'`,
          )
          .get(threadId, input.organizationId, input.employeeId, input.agentId);
        if (!thread) throw new ExecutionError(404, 'THREAD_NOT_FOUND');
        if (
          this.db
            .prepare(
              `SELECT 1 FROM agent_runs WHERE thread_id=? AND status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')`,
            )
            .get(threadId)
        )
          throw new ExecutionError(409, 'THREAD_HAS_ACTIVE_RUN');
      } else if (input.conversation) {
        threadId = this.conversationThread(input, input.conversation);
      } else threadId = this.insertThread(input, null, input.title);
      const runId = this.insertRun({
        ...input,
        threadId,
        manifest,
        runtimeProfile,
        legacyQaRunId: null,
      });
      this.appendEvent(
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
  recordLegacyQaRun(input: LegacyQaRunInput): {
    id: string;
    threadId: string;
    status: AgentRunStatus;
  } {
    return this.transaction(() => {
      const threadId = this.threadForConversation(input);
      const task: TaskSpec = {
        objective: `Validate ${input.storyKey} against ${new URL(input.targetUrl).origin}`,
        workflow: 'validate-story',
        workItem: { system: 'issue-tracker', key: input.storyKey },
        inputs: { targetUrl: input.targetUrl },
      };
      const runId = this.insertRun({
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
      this.appendEvent(scope, 'run.created', 'CONTROL_PLANE', input.employeeId, {
        task,
        runtimeProfile: LEGACY_QA_RUNTIME_PROFILE,
        legacyQaRunId: input.qaRunId,
      });
      this.transitionRun(scope, 'RUNNING', null);
      this.appendEvent(scope, 'run.started', 'CONTROL_PLANE', null, {
        executor: 'control-plane.legacy-qa-static-plan',
      });
      const planStep = this.insertStep(scope, 'PLAN', 'Prepare QA test plan', 'COMPLETED', {
        plan: input.plan,
      });
      this.appendEvent(
        scope,
        'step.completed',
        'CONTROL_PLANE',
        null,
        { plan: input.plan },
        planStep,
      );
      const action = 'qa.execute_playwright';
      const actionStep = this.insertStep(scope, 'ACTION', action, 'WAITING_FOR_APPROVAL', {
        action,
        targetOrigin: new URL(input.targetUrl).origin,
      });
      this.db
        .prepare('UPDATE approvals SET run_id=?, step_id=? WHERE id=? AND organization_id=?')
        .run(runId, actionStep, input.approvalId, input.organizationId);
      this.appendEvent(
        scope,
        'approval.requested',
        'CONTROL_PLANE',
        input.employeeId,
        { approvalId: input.approvalId, action, risk: 'MEDIUM', summary: input.approvalSummary },
        actionStep,
      );
      this.transitionRun(scope, 'WAITING_FOR_APPROVAL', 'APPROVAL_REQUIRED');
      this.appendEvent(scope, 'run.paused', 'CONTROL_PLANE', null, {
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
  ): void {
    this.transaction(() => {
      const link = this.db
        .prepare('SELECT run_id, step_id FROM approvals WHERE id=? AND organization_id=?')
        .get(approvalId, organizationId) as
        { run_id: string | null; step_id: string | null } | undefined;
      if (!link?.run_id) return;
      const run = this.runRow(organizationId, link.run_id);
      const scope = { organizationId, threadId: run.threadId, runId: run.id };
      const stepId = link.step_id ?? undefined;
      this.appendEvent(
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
        stepId && this.stepRow(organizationId, run.id, stepId).status === 'WAITING_FOR_APPROVAL'
          ? stepId
          : undefined;
      if (decision === 'APPROVED') {
        if (waitingStep) this.transitionStep(organizationId, waitingStep, 'PENDING');
        this.transitionRun(scope, 'QUEUED', APPROVAL_GRANTED);
      } else {
        if (waitingStep) this.transitionStep(organizationId, waitingStep, 'CANCELLED');
        this.transitionRun(scope, 'CANCELLED', APPROVAL_REJECTED);
        this.appendEvent(scope, 'run.cancelled', 'CONTROL_PLANE', actorId, {
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
  ): void {
    this.transaction(() => {
      const run = this.runRow(organizationId, runId);
      if (run.status !== 'RUNNING') throw new ExecutionError(409, 'RUN_NOT_RUNNING');
      const scope = { organizationId, threadId: run.threadId, runId };
      const step = this.stepRow(organizationId, runId, stepId);
      this.transitionStep(organizationId, step.id, 'WAITING_FOR_APPROVAL');
      this.appendEvent(
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
      this.transitionRun(scope, 'WAITING_FOR_APPROVAL', 'APPROVAL_REQUIRED');
      this.appendEvent(scope, 'run.paused', 'CONTROL_PLANE', null, {
        reason: 'APPROVAL_REQUIRED',
        approvalId: approval.id,
      });
      this.syncConversation(
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
  ): AgentRun {
    return this.transaction(() => {
      const run = this.runRow(organizationId, runId);
      if (!canTransitionRun(run.status, 'CANCELLED')) throw new ExecutionError(409, 'RUN_TERMINAL');
      const scope = { organizationId, threadId: run.threadId, runId };
      const open = this.db
        .prepare(
          `SELECT id FROM agent_run_steps WHERE run_id=? AND organization_id=?
           AND status IN ('PENDING','RUNNING','WAITING_FOR_APPROVAL')`,
        )
        .all(runId, organizationId) as { id: string }[];
      for (const step of open) this.transitionStep(organizationId, step.id, 'CANCELLED');
      this.transitionRun(scope, 'CANCELLED', reason);
      this.appendEvent(scope, 'run.cancelled', 'CONTROL_PLANE', actorId, { reason });
      this.syncConversation(scope, `The run was cancelled (${reason}).`);
      return this.mapRun(this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId) as Row);
    });
  }

  /** The owning employee cancels their own run. */
  cancelOwnRun(actor: Actor, runId: string): AgentRun {
    const run = this.readableRun(actor, runId, false);
    return this.cancelRun(actor.organizationId, run.id, 'CANCELLED_BY_EMPLOYEE', actor.id);
  }

  /** Employee-facing run view (no runtime bookkeeping). */
  getOwnRun(actor: Actor, runId: string): AgentRun {
    return this.readableRun(actor, runId, false);
  }

  /** An approval expired unused: the run it paused is cancelled (fail closed, ADR 0012). */
  onApprovalExpired(organizationId: string, approvalId: string): void {
    this.transaction(() => {
      const link = this.db
        .prepare('SELECT run_id, step_id FROM approvals WHERE id=? AND organization_id=?')
        .get(approvalId, organizationId) as
        { run_id: string | null; step_id: string | null } | undefined;
      if (!link?.run_id) return;
      const run = this.runRow(organizationId, link.run_id);
      const scope = { organizationId, threadId: run.threadId, runId: run.id };
      this.appendEvent(
        scope,
        'approval.expired',
        'CONTROL_PLANE',
        null,
        { approvalId },
        link.step_id ?? undefined,
      );
      if (run.status === 'WAITING_FOR_APPROVAL')
        this.cancelRun(organizationId, run.id, 'APPROVAL_EXPIRED', null);
    });
  }

  /**
   * Validate and record one runtime-emitted event (agents-foundry/runtime/v1).
   * The caller must authenticate the runtime and supply the tenant it is authorized for.
   */
  ingestRuntimeEvent(
    organizationId: string,
    input: unknown,
  ): { event: AgentEvent; duplicate: boolean } {
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
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM agent_events WHERE id=? AND organization_id=?')
        .get(envelope.eventId, organizationId) as Row | undefined;
      if (existing) {
        if (existing['payload_hash'] !== payloadHash)
          throw new ExecutionError(409, 'RUNTIME_EVENT_CONFLICT');
        return { event: this.mapEvent(existing), duplicate: true };
      }
      if (this.db.prepare('SELECT 1 FROM agent_events WHERE id=?').get(envelope.eventId))
        throw new ExecutionError(409, 'RUNTIME_EVENT_CONFLICT');
      const run = this.runRow(organizationId, envelope.runId);
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
        const approval = this.db
          .prepare(
            `SELECT step_id FROM approvals WHERE id=? AND organization_id=? AND run_id=? AND status='APPROVED'`,
          )
          .get(envelope.payload.approvalId, organizationId, run.id) as
          { step_id: string | null } | undefined;
        if (!approval) throw new ExecutionError(409, 'RUNTIME_APPROVAL_MISMATCH');
        if (
          approval.step_id &&
          this.stepRow(organizationId, run.id, approval.step_id).status === 'PENDING'
        )
          this.transitionStep(organizationId, approval.step_id, 'RUNNING');
      }
      if (envelope.type === 'step.started') {
        if (this.db.prepare('SELECT 1 FROM agent_run_steps WHERE id=?').get(stepId!))
          throw new ExecutionError(409, 'STEP_ALREADY_EXISTS');
        this.insertStep(
          scope,
          envelope.payload.kind,
          envelope.payload.title,
          'RUNNING',
          {},
          stepId,
        );
      } else if (stepId) {
        const step = this.stepRow(organizationId, run.id, stepId);
        if (envelope.type === 'step.completed' || envelope.type === 'step.failed')
          this.transitionStep(
            organizationId,
            step.id,
            envelope.type === 'step.completed' ? 'COMPLETED' : 'FAILED',
          );
      }
      if (envelope.type === 'artifact.created') {
        const artifact = envelope.payload.artifact;
        if (this.db.prepare('SELECT 1 FROM agent_artifacts WHERE id=?').get(artifact.id))
          throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
        this.db
          .prepare(
            `INSERT INTO agent_artifacts (id,organization_id,thread_id,run_id,step_id,artifact_type,media_type,name,
             storage_reference,checksum_sha256,size_bytes,retention_policy,created_at,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
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
      this.db
        .prepare(
          'UPDATE agent_runs SET runtime_sequence=?, updated_at=? WHERE id=? AND organization_id=?',
        )
        .run(envelope.sequence, now(), run.id, organizationId);
      if (decision.nextStatus !== run.status)
        this.transitionRun(scope, decision.nextStatus, reason);
      // Artifacts are referenced by id in the event; the storage reference stays out of history.
      const payload =
        envelope.type === 'artifact.created'
          ? { artifactId: envelope.payload.artifact.id, type: envelope.payload.artifact.type }
          : envelope.payload;
      const id = this.appendEvent(scope, envelope.type, 'RUNTIME', RUNTIME_ACTOR, payload, stepId, {
        id: envelope.eventId,
        runtimeSequence: envelope.sequence,
        occurredAt: envelope.occurredAt,
        payloadHash,
      });
      if (envelope.type === 'run.completed') this.syncConversation(scope, envelope.payload.summary);
      else if (envelope.type === 'run.failed')
        this.syncConversation(
          scope,
          `The run failed: ${envelope.payload.error.code}. ${envelope.payload.error.message}`,
        );
      else if (envelope.type === 'run.cancelled')
        this.syncConversation(scope, `The run was cancelled (${envelope.payload.reason}).`);
      return {
        event: this.mapEvent(
          this.db.prepare('SELECT * FROM agent_events WHERE id=?').get(id) as Row,
        ),
        duplicate: false,
      };
    });
  }

  /** Build the `run.submit` command for a queued run. Only v2 manifests can be executed. */
  buildRunSubmitCommand(organizationId: string, runId: string): RunSubmitCommand {
    const run = this.runRow(organizationId, runId);
    if (run.status !== 'QUEUED' || run.statusReason !== null)
      throw new ExecutionError(409, 'RUN_NOT_SUBMITTABLE');
    if (!run.manifest || run.manifest.apiVersion !== 'agents-foundry/v2')
      throw new ExecutionError(409, 'RUNTIME_MANIFEST_V2_REQUIRED');
    const manifest = this.loadManifest(run.agentId, organizationId, run.employeeId);
    if (
      manifest.payload.apiVersion !== 'agents-foundry/v2' ||
      manifest.payload.metadata.manifestId !== run.manifest.manifestId
    )
      throw new ExecutionError(409, 'MANIFEST_INVALID');
    let workflow: WorkflowDefinition | undefined;
    if (run.task.workflow) {
      workflow = manifest.payload.workflows.includes(run.task.workflow)
        ? this.options.resolveWorkflow?.(manifest, run.task.workflow)
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
  }

  getThread(actor: Actor, threadId: string): ThreadDetail {
    const row = this.db
      .prepare('SELECT * FROM agent_threads WHERE id=? AND organization_id=?')
      .get(threadId, actor.organizationId) as Row | undefined;
    if (!row || row['employee_id'] !== actor.id) throw new ExecutionError(404, 'THREAD_NOT_FOUND');
    const runs = this.db
      .prepare(
        'SELECT * FROM agent_runs WHERE thread_id=? AND organization_id=? ORDER BY created_at, rowid',
      )
      .all(threadId, actor.organizationId) as Row[];
    return { thread: this.mapThread(row), runs: runs.map((run) => this.mapRun(run)) };
  }

  /** Run governance view: the owning employee, or an administrator of the same organization. */
  getRun(actor: Actor, runId: string): AgentRunDetail {
    const run = this.readableRun(actor, runId, true);
    const steps = this.db
      .prepare(
        'SELECT * FROM agent_run_steps WHERE run_id=? AND organization_id=? ORDER BY sequence',
      )
      .all(run.id, actor.organizationId) as Row[];
    const approvals = this.db
      .prepare(
        `SELECT id, action, risk, status, step_id, created_at, decided_at, expires_at FROM approvals
         WHERE run_id=? AND organization_id=? ORDER BY created_at, rowid`,
      )
      .all(run.id, actor.organizationId) as Row[];
    const artifacts = this.db
      .prepare(
        'SELECT * FROM agent_artifacts WHERE run_id=? AND organization_id=? ORDER BY created_at, rowid',
      )
      .all(run.id, actor.organizationId) as Row[];
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
  }

  /** Event history is conversation-grade content: only the owning employee may read it. */
  listEvents(actor: Actor, runId: string, afterSequence: number, limit: number): AgentEventPage {
    const run = this.readableRun(actor, runId, false);
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_events WHERE run_id=? AND organization_id=? AND sequence>? ORDER BY sequence LIMIT ?',
      )
      .all(run.id, actor.organizationId, afterSequence, limit) as Row[];
    const items = rows.map((row) => this.mapEvent(row));
    return { items, nextAfterSequence: items.at(-1)?.sequence ?? afterSequence };
  }

  private readableRun(actor: Actor, runId: string, allowAdmin: boolean): AgentRun {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id=? AND organization_id=?')
      .get(runId, actor.organizationId) as Row | undefined;
    if (!row || (row['employee_id'] !== actor.id && !(allowAdmin && actor.role === 'ADMIN')))
      throw new ExecutionError(404, 'RUN_NOT_FOUND');
    return this.mapRun(row);
  }

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Reuse the conversation's latest idle thread; a busy thread gets a sibling (one active run each). */
  /**
   * The conversation's thread for a generic run. One thread per conversation keeps the
   * execution workspace (which is per thread); a thread with an active run is refused.
   */
  private conversationThread(
    owner: { organizationId: string; employeeId: string; agentId: string },
    conversation: { id: string; title: string },
  ): string {
    const thread = this.db
      .prepare(
        `SELECT id FROM agent_threads WHERE organization_id=? AND conversation_id=? AND agent_id=? AND employee_id=?
         AND status='ACTIVE' ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(owner.organizationId, conversation.id, owner.agentId, owner.employeeId) as
      { id: string } | undefined;
    if (!thread) return this.insertThread(owner, conversation.id, conversation.title);
    if (
      this.db
        .prepare(
          `SELECT 1 FROM agent_runs WHERE thread_id=? AND status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')`,
        )
        .get(thread.id)
    )
      throw new ExecutionError(409, 'THREAD_HAS_ACTIVE_RUN');
    this.db.prepare('UPDATE agent_threads SET updated_at=? WHERE id=?').run(now(), thread.id);
    return thread.id;
  }

  /** Mirror a generic run's outcome into its conversation (conversationSync: REQUIRED). */
  private syncConversation(
    scope: { organizationId: string; threadId: string; runId: string },
    content: string,
  ): void {
    if (!this.options.conversationMessage) return;
    const link = this.db
      .prepare(
        `SELECT t.conversation_id FROM agent_threads t JOIN agent_runs r ON r.thread_id=t.id
         WHERE r.id=? AND r.organization_id=? AND r.legacy_qa_run_id IS NULL`,
      )
      .get(scope.runId, scope.organizationId) as { conversation_id: string | null } | undefined;
    if (!link?.conversation_id) return;
    this.options.conversationMessage(
      scope.organizationId,
      link.conversation_id,
      content.slice(0, 20_000),
    );
  }

  private threadForConversation(input: LegacyQaRunInput): string {
    const idle = this.db
      .prepare(
        `SELECT t.id FROM agent_threads t WHERE t.organization_id=? AND t.conversation_id=? AND t.agent_id=?
         AND t.employee_id=? AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.thread_id=t.id
         AND r.status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL')) ORDER BY t.updated_at DESC, t.rowid DESC LIMIT 1`,
      )
      .get(input.organizationId, input.conversationId, input.agentId, input.employeeId) as
      { id: string } | undefined;
    if (idle) {
      this.db.prepare('UPDATE agent_threads SET updated_at=? WHERE id=?').run(now(), idle.id);
      return idle.id;
    }
    return this.insertThread(input, input.conversationId, input.conversationTitle);
  }

  private insertThread(
    owner: { organizationId: string; employeeId: string; agentId: string },
    conversationId: string | null,
    title: string,
  ): string {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO agent_threads (id,organization_id,employee_id,agent_id,conversation_id,title,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'ACTIVE',?,?)`,
      )
      .run(
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

  private insertRun(input: {
    organizationId: string;
    threadId: string;
    employeeId: string;
    agentId: string;
    manifest: ManifestReference | null;
    task: TaskSpec;
    runtimeProfile: string;
    legacyQaRunId: string | null;
  }): string {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id,organization_id,thread_id,employee_id,agent_id,manifest_id,manifest_api_version,
         manifest_key_id,task,runtime_profile,status,legacy_qa_run_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?)`,
      )
      .run(
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

  private insertStep(
    scope: { organizationId: string; runId: string },
    kind: RunStepKind,
    title: string,
    status: RunStepStatus,
    detail: Record<string, unknown>,
    id: string = randomUUID(),
  ): string {
    const timestamp = now();
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_run_steps WHERE run_id=?')
      .get(scope.runId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO agent_run_steps (id,organization_id,run_id,sequence,kind,title,status,detail,created_at,started_at,completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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

  private appendEvent(
    scope: { organizationId: string; threadId: string; runId: string },
    type: AgentEventType,
    source: AgentEventSource,
    actorId: string | null,
    payload: object,
    stepId?: string,
    runtime?: { id: string; runtimeSequence: number; occurredAt: string; payloadHash: string },
  ): string {
    const id = runtime?.id ?? randomUUID();
    const recordedAt = now();
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_events WHERE run_id=?')
      .get(scope.runId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO agent_events (id,organization_id,thread_id,run_id,step_id,sequence,runtime_sequence,event_type,source,
         actor_id,payload,payload_hash,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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

  private transitionRun(
    scope: { organizationId: string; runId: string },
    to: AgentRunStatus,
    reason: string | null,
  ): void {
    const run = this.runRow(scope.organizationId, scope.runId);
    if (run.status !== to && !canTransitionRun(run.status, to))
      throw new ExecutionError(409, 'ILLEGAL_RUN_TRANSITION');
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE agent_runs SET status=?, status_reason=?, updated_at=?,
         started_at=COALESCE(started_at, CASE WHEN ?='RUNNING' THEN ? END),
         completed_at=CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED') THEN ? ELSE completed_at END
         WHERE id=? AND organization_id=?`,
      )
      .run(to, reason, timestamp, to, timestamp, to, timestamp, scope.runId, scope.organizationId);
  }

  private transitionStep(organizationId: string, stepId: string, to: RunStepStatus): void {
    const row = this.db
      .prepare('SELECT status FROM agent_run_steps WHERE id=? AND organization_id=?')
      .get(stepId, organizationId) as { status: RunStepStatus } | undefined;
    if (!row) throw new ExecutionError(404, 'STEP_NOT_FOUND');
    if (!canTransitionStep(row.status, to))
      throw new ExecutionError(409, 'ILLEGAL_STEP_TRANSITION');
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE agent_run_steps SET status=?,
         completed_at=CASE WHEN ? IN ('COMPLETED','FAILED','SKIPPED','CANCELLED') THEN ? ELSE completed_at END
         WHERE id=? AND organization_id=?`,
      )
      .run(to, to, timestamp, stepId, organizationId);
  }

  private runRow(organizationId: string, runId: string) {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id=? AND organization_id=?')
      .get(runId, organizationId) as Row | undefined;
    if (!row) throw new ExecutionError(404, 'RUN_NOT_FOUND');
    return { ...this.mapRun(row), runtimeSequence: Number(row['runtime_sequence']) };
  }

  private stepRow(organizationId: string, runId: string, stepId: string): RunStep {
    const row = this.db
      .prepare('SELECT * FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?')
      .get(stepId, runId, organizationId) as Row | undefined;
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
    };
  }
}
