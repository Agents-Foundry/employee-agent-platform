import { createHash, randomUUID } from 'node:crypto';
import type {
  RuntimeActionDecision,
  RuntimeActionExecution,
  RuntimeActionRequest,
  RuntimeCheckpointAck,
  RuntimeCheckpointRecord,
  RuntimeClaimResponse,
  RuntimeCommand,
  RuntimeCorrelation,
  RuntimeEventAck,
  RuntimeHeartbeat,
  RuntimeModelCredential,
  RuntimeModelReservation,
  RuntimeModelSettlement,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../../packages/contracts/src/runtime/v1/protocol.js';
import {
  parseRuntimeActionExecuteRequest,
  parseRuntimeActionRequest,
  parseRuntimeCheckpointLoadRequest,
  parseRuntimeCheckpointSaveRequest,
  parseRuntimeEvent,
  parseRuntimeHeartbeatRequest,
  parseRuntimeModelCredentialRequest,
  parseRuntimeModelReservationRequest,
  parseRuntimeModelSettlementRequest,
} from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import type { ActionGateway } from '../actions/action-gateway.js';
import type { Audit } from '../actions/action-policy-service.js';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';
import { ExecutionError, type ExecutionService } from '../execution/execution-service.js';
import type { ModelSpendingService } from '../spending/model-spending-service.js';
import {
  ModelCredentialRefused,
  type ModelCredentialService,
} from '../secrets/model-credentials.js';
import { RunCheckpoints, sha256Text } from './run-checkpoints.js';
import { servesOrganization, type RuntimeIdentity } from './runtime-identity.js';

/**
 * A lease lasts this long past its runtime's last sign of life (an event, a heartbeat, a
 * checkpoint). After it, a run that never started, or one with a durable checkpoint, can be
 * claimed by another runtime.
 */
export const RUNTIME_LEASE_MS = 10 * 60_000;
/** A running run is handed to another runtime at most this many times, then cancelled. */
export const MAX_RUN_RECOVERIES = 3;
/** An abandoned run that no runtime picks up within this window is cancelled. */
export const RUN_RECOVERY_WINDOW_MS = 24 * 60 * 60_000;
/** A command delivered but not acted on is redelivered after this (runtime restart). */
export const COMMAND_REDELIVERY_MS = 60_000;

export interface RuntimeTransportDependencies {
  gateway: ActionGateway;
  audit: Audit;
  spending: ModelSpendingService;
  modelCredentials: ModelCredentialService;
}

/**
 * Control-plane side of the runtime transport (ADR 0011). Every method takes an already
 * authenticated runtime identity. Tenancy comes from the stored run and lease, never from
 * the runtime's message; a runtime can only act on runs it holds a lease for.
 *
 * Claiming reads the queue across organizations (platform scope). Everything done for a
 * leased run runs in that run's tenant scope, where the lease is checked again (ADR 0018).
 */
export class RuntimeTransportService {
  readonly checkpoints: RunCheckpoints;

  constructor(
    private readonly db: PgStore,
    private readonly execution: ExecutionService,
    private readonly deps: RuntimeTransportDependencies,
  ) {
    this.checkpoints = new RunCheckpoints(db);
  }

  /** Single-use nonces for signed requests; expired entries are purged opportunistically. */
  consumeNonce(runtimeId: string, nonce: string, expiresAt: number): Promise<boolean> {
    return this.db.platform(async () => {
      await this.db.run('DELETE FROM runtime_request_nonces WHERE expires_at < ?', Date.now());
      const inserted = await this.db.run(
        'INSERT INTO runtime_request_nonces (runtime_id, nonce, expires_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
        runtimeId,
        nonce,
        expiresAt,
      );
      return inserted.changes === 1;
    });
  }

  /**
   * Hand the runtime its next command: a cancellation for a run it holds, a resume for one of
   * its runs released by an approval, an abandoned run to continue from its checkpoint, or a
   * fresh queued run it is authorized to execute.
   */
  async claim(runtime: RuntimeIdentity, nowMs = Date.now()): Promise<RuntimeClaimResponse | null> {
    // Expired approvals cancel their runs first, so they are delivered as run.cancel below.
    await this.deps.gateway.expireDue(nowMs);
    await this.reapAbandoned(nowMs);
    return this.db.platform(async () => {
      const nowIso = new Date(nowMs).toISOString();
      const held = await this.db.all(
        `SELECT l.*, r.status, r.status_reason, r.runtime_sequence, r.runtime_profile FROM agent_run_leases l
         JOIN agent_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
         WHERE l.runtime_id=? AND l.state='ACTIVE' ORDER BY l.claimed_at, l.seq`,
        runtime.id,
      );
      for (const lease of held) {
        const organizationId = String(lease['organization_id']);
        const runId = String(lease['run_id']);
        const status = String(lease['status']);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
          await this.closeLease(runId, nowIso);
          if (status === 'CANCELLED')
            return this.respond(lease, {
              ...(await this.commandBase(organizationId, runId)),
              type: 'run.cancel',
              runId,
              reason: String(lease['status_reason'] ?? 'CANCELLED'),
            });
          continue;
        }
        if (!servesOrganization(runtime, organizationId)) continue;
        // This runtime stopped signalling the run it holds (it restarted): continue it here.
        if (status === 'RUNNING' && Date.parse(String(lease['lease_expires_at'])) < nowMs) {
          const recovered = await this.takeOver(runtime, lease, nowMs);
          if (recovered) return recovered;
          continue;
        }
        const redeliver =
          Date.parse(String(lease['heartbeat_at'])) + COMMAND_REDELIVERY_MS <= nowMs;
        if (status === 'QUEUED' && lease['status_reason'] === 'APPROVAL_GRANTED') {
          const approval = await this.db.get<{ id: string; decided_at: string }>(
            `SELECT id, decided_at FROM approvals WHERE run_id=? AND organization_id=? AND status='APPROVED'
             ORDER BY decided_at DESC, seq DESC LIMIT 1`,
            runId,
            organizationId,
          );
          if (!approval) continue;
          const marker = `run.resume:${approval.id}`;
          if (lease['last_command'] === marker && !redeliver) continue;
          await this.touchLease(runId, nowMs, marker);
          return this.respond(lease, {
            ...(await this.commandBase(organizationId, runId)),
            type: 'run.resume',
            runId,
            approval: {
              approvalId: approval.id,
              decision: 'APPROVED',
              decidedAt: approval.decided_at,
            },
          });
        }
        if (status === 'QUEUED' && lease['status_reason'] === null && redeliver) {
          const command = await this.submitCommand(organizationId, runId, nowIso);
          if (!command) continue;
          await this.touchLease(runId, nowMs, 'run.submit');
          return this.respond(lease, command);
        }
      }
      return (await this.claimAbandoned(runtime, nowMs)) ?? this.claimQueued(runtime, nowMs);
    });
  }

  /**
   * Keep the leases of the runs a runtime is executing alive. A run it names but no longer
   * holds is `lost`: another runtime has it, or it ended.
   */
  async heartbeat(
    runtime: RuntimeIdentity,
    body: unknown,
    nowMs = Date.now(),
  ): Promise<RuntimeHeartbeat> {
    const { runIds } = parseRuntimeHeartbeatRequest(body);
    return this.db.platform(async () => {
      const held: string[] = [];
      const lost: string[] = [];
      for (const runId of new Set(runIds)) {
        const touched = await this.db.run(
          `UPDATE agent_run_leases SET heartbeat_at=?, lease_expires_at=?
           WHERE run_id=? AND runtime_id=? AND state='ACTIVE'`,
          new Date(nowMs).toISOString(),
          new Date(nowMs + RUNTIME_LEASE_MS).toISOString(),
          runId,
          runtime.id,
        );
        (touched.changes === 1 ? held : lost).push(runId);
      }
      return { held, lost };
    });
  }

  /**
   * Cancel abandoned runs nothing can continue (ADR 0032): a running run whose lease expired
   * without a durable checkpoint, and any abandoned run no runtime picked up in time.
   */
  async reapAbandoned(nowMs = Date.now()): Promise<number> {
    return this.db.platform(async () => {
      const nowIso = new Date(nowMs).toISOString();
      const stale = await this.db.all<{
        run_id: string;
        organization_id: string;
        status: string;
        idle_since: string;
        checkpointed: boolean;
      }>(
        `SELECT l.run_id, l.organization_id, r.status,
          GREATEST(l.lease_expires_at, r.updated_at) AS idle_since,
          EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.run_id=l.run_id) AS checkpointed
         FROM agent_run_leases l
         JOIN agent_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
         WHERE l.state='ACTIVE' AND l.lease_expires_at < ?
         AND (r.status='RUNNING' OR (r.status='QUEUED' AND r.status_reason='APPROVAL_GRANTED'))
         ORDER BY l.lease_expires_at LIMIT 50`,
        nowIso,
      );
      let reaped = 0;
      for (const item of stale) {
        const expired = Date.parse(String(item.idle_since)) + RUN_RECOVERY_WINDOW_MS < nowMs;
        if (!expired && (item.status !== 'RUNNING' || item.checkpointed)) continue;
        await this.abandon(item.organization_id, item.run_id, 'RUNTIME_LOST', nowIso);
        reaped += 1;
      }
      return reaped;
    });
  }

  /** Save the next checkpoint of a run this runtime holds (ADR 0032). */
  async saveCheckpoint(
    runtime: RuntimeIdentity,
    body: unknown,
    nowMs = Date.now(),
  ): Promise<RuntimeCheckpointAck> {
    const request = parseRuntimeCheckpointSaveRequest(body);
    const { correlation, binding } = request;
    const organizationId = await this.leaseOrganization(runtime, correlation.runId);
    return this.db.tenant(organizationId, async () => {
      const { lease, run } = await this.heldRun(runtime, correlation, [
        'RUNNING',
        'WAITING_FOR_APPROVAL',
      ]);
      // A runtime that lost the run to another session can no longer advance it.
      if (lease['session_id'] !== request.sessionId)
        throw new ExecutionError(409, 'CHECKPOINT_SESSION_STALE');
      if (sha256Text(request.body) !== request.sha256)
        throw new ExecutionError(400, 'CHECKPOINT_DIGEST_MISMATCH');
      if (
        binding.manifestId !== run.manifestId ||
        binding.manifestDigest !== run.manifestDigest ||
        binding.workflow !== run.workflow ||
        binding.runtimeSequence > run.runtimeSequence
      )
        throw new ExecutionError(409, 'CHECKPOINT_BINDING_MISMATCH');
      if (
        binding.stepId &&
        !(await this.db.get(
          'SELECT 1 AS found FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?',
          binding.stepId,
          correlation.runId,
          organizationId,
        ))
      )
        throw new ExecutionError(409, 'CHECKPOINT_BINDING_MISMATCH');
      if (
        binding.approvalId &&
        !(await this.db.get(
          'SELECT 1 AS found FROM approvals WHERE id=? AND run_id=? AND organization_id=?',
          binding.approvalId,
          correlation.runId,
          organizationId,
        ))
      )
        throw new ExecutionError(409, 'CHECKPOINT_BINDING_MISMATCH');
      await this.checkpoints.append(
        organizationId,
        run.threadId,
        runtime.id,
        request,
        new Date(nowMs).toISOString(),
      );
      await this.touchLease(correlation.runId, nowMs);
      return { runId: correlation.runId, version: request.version };
    });
  }

  /** The latest checkpoint of a run this runtime holds, if it still matches the run. */
  async loadCheckpoint(
    runtime: RuntimeIdentity,
    body: unknown,
  ): Promise<RuntimeCheckpointRecord | null> {
    const { correlation } = parseRuntimeCheckpointLoadRequest(body);
    const organizationId = await this.leaseOrganization(runtime, correlation.runId);
    return this.db.tenant(organizationId, async () => {
      const { run } = await this.heldRun(runtime, correlation, [
        'QUEUED',
        'RUNNING',
        'WAITING_FOR_APPROVAL',
      ]);
      const record = await this.checkpoints.read(organizationId, correlation.runId);
      if (!record) return null;
      if (
        record.binding.manifestId !== run.manifestId ||
        record.binding.manifestDigest !== run.manifestDigest ||
        record.binding.workflow !== run.workflow ||
        record.binding.runtimeSequence > run.runtimeSequence
      )
        throw new ExecutionError(409, 'CHECKPOINT_BINDING_MISMATCH');
      return record;
    });
  }

  /** Lease and correlation checks for a run the runtime holds, in one of `statuses`. */
  private async heldRun(
    runtime: RuntimeIdentity,
    correlation: RuntimeCorrelation,
    statuses: readonly string[],
  ) {
    const lease = await this.ownedLease(runtime, correlation.runId);
    const organizationId = String(lease['organization_id']);
    if (lease['state'] !== 'ACTIVE') throw new ExecutionError(409, 'RUN_TERMINAL');
    const run = await this.execution.runBinding(organizationId, correlation.runId);
    if (
      run.threadId !== correlation.threadId ||
      run.employeeId !== correlation.employeeId ||
      run.agentId !== correlation.agentId ||
      correlation.organizationId !== organizationId
    )
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    if (!statuses.includes(run.status)) throw new ExecutionError(409, 'RUN_NOT_RUNNING');
    return { lease, run };
  }

  /** Abandoned runs with a durable checkpoint that this runtime may continue. */
  private async claimAbandoned(
    runtime: RuntimeIdentity,
    nowMs: number,
  ): Promise<RuntimeClaimResponse | null> {
    const profiles = [...runtime.runtimeProfiles];
    const tenants = runtime.organizations === '*' ? null : [...runtime.organizations];
    const candidates = await this.db.all(
      `SELECT l.*, r.status, r.status_reason FROM agent_run_leases l
       JOIN agent_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
       WHERE l.state='ACTIVE' AND l.lease_expires_at < ?
       AND (r.status='RUNNING' OR (r.status='QUEUED' AND r.status_reason='APPROVAL_GRANTED'))
       AND r.runtime_profile IN (${profiles.map(() => '?').join(',')})
       ${tenants ? `AND r.organization_id IN (${tenants.map(() => '?').join(',')})` : ''}
       ORDER BY l.lease_expires_at, l.seq LIMIT 20`,
      new Date(nowMs).toISOString(),
      ...profiles,
      ...(tenants ?? []),
    );
    for (const candidate of candidates) {
      const claimed = await this.takeOver(runtime, candidate, nowMs);
      if (claimed) return claimed;
    }
    return null;
  }

  /**
   * Give an abandoned run to `runtime` under a new lease session and build its command:
   * `run.recover` for a running run, `run.resume` for one an approval released. Without a
   * durable checkpoint the run stays with its holder (a running one is cancelled by the
   * reaper). The previous session can no longer send events or checkpoints for the run.
   */
  private async takeOver(
    runtime: RuntimeIdentity,
    lease: Row,
    nowMs: number,
  ): Promise<RuntimeClaimResponse | null> {
    const organizationId = String(lease['organization_id']);
    const runId = String(lease['run_id']);
    const running = lease['status'] === 'RUNNING';
    const nowIso = new Date(nowMs).toISOString();
    if (!(await this.checkpoints.exists(runId))) return null;
    if (running && Number(lease['recoveries']) >= MAX_RUN_RECOVERIES) {
      await this.abandon(organizationId, runId, 'RUNTIME_RECOVERY_EXHAUSTED', nowIso);
      return null;
    }
    try {
      await this.execution.runBinding(organizationId, runId);
    } catch (error) {
      if (!(error instanceof ExecutionError)) throw error;
      await this.abandon(organizationId, runId, 'MANIFEST_INVALID', nowIso);
      return null;
    }
    const approval = running
      ? null
      : await this.db.get<{ id: string; decided_at: string }>(
          `SELECT id, decided_at FROM approvals WHERE run_id=? AND organization_id=? AND status='APPROVED'
           ORDER BY decided_at DESC, seq DESC LIMIT 1`,
          runId,
          organizationId,
        );
    if (!running && !approval) return null;
    const sessionId = randomUUID();
    const moved = await this.db.run(
      `UPDATE agent_run_leases SET runtime_id=?, session_id=?, last_command=?, heartbeat_at=?,
       lease_expires_at=?, recoveries=recoveries+? WHERE run_id=? AND state='ACTIVE' AND session_id=?
       AND lease_expires_at < ?`,
      runtime.id,
      sessionId,
      running ? 'run.recover' : `run.resume:${approval!.id}`,
      nowIso,
      new Date(nowMs + RUNTIME_LEASE_MS).toISOString(),
      running ? 1 : 0,
      runId,
      String(lease['session_id']),
      nowIso,
    );
    if (moved.changes !== 1) return null;
    await this.deps.audit(
      runtime.id,
      'runtime.run.recovered',
      'agent_run',
      runId,
      {
        runtimeId: runtime.id,
        previousRuntimeId: String(lease['runtime_id']),
        sessionId,
        command: running ? 'run.recover' : 'run.resume',
      },
      organizationId,
    );
    const base = await this.commandBase(organizationId, runId);
    return this.respond(
      lease,
      running
        ? {
            ...base,
            type: 'run.recover',
            runId,
            reason: 'LEASE_EXPIRED',
            openStepIds: await this.execution.openSteps(organizationId, runId),
          }
        : {
            ...base,
            type: 'run.resume',
            runId,
            approval: {
              approvalId: approval!.id,
              decision: 'APPROVED',
              decidedAt: approval!.decided_at,
            },
          },
    );
  }

  private async abandon(
    organizationId: string,
    runId: string,
    code: string,
    nowIso: string,
  ): Promise<void> {
    await this.execution.cancelRun(organizationId, runId, code, null);
    await this.closeLease(runId, nowIso);
    await this.deps.audit(
      'control-plane',
      'runtime.run.abandoned',
      'agent_run',
      runId,
      { code },
      organizationId,
    );
  }

  /** Record one runtime event for a run the runtime holds. */
  async ingest(
    runtime: RuntimeIdentity,
    body: unknown,
    nowMs = Date.now(),
  ): Promise<RuntimeEventAck> {
    const envelope = parseRuntimeEvent(body);
    const organizationId = await this.leaseOrganization(runtime, envelope.runId);
    return this.db.tenant(organizationId, async () => {
      const lease = await this.ownedLease(runtime, envelope.runId);
      if (
        envelope.type === 'run.started' &&
        envelope.payload.runtimeSessionId !== lease['session_id']
      )
        throw new ExecutionError(409, 'RUNTIME_SESSION_MISMATCH');
      const { event, duplicate } = await this.execution.ingestRuntimeEvent(
        String(lease['organization_id']),
        body,
      );
      if (lease['state'] === 'ACTIVE') {
        const run = (await this.db.get<{ status: string }>(
          'SELECT status FROM agent_runs WHERE id=? AND organization_id=?',
          envelope.runId,
          organizationId,
        ))!;
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status))
          await this.closeLease(envelope.runId, new Date(nowMs).toISOString());
        else await this.touchLease(envelope.runId, nowMs);
      }
      return { eventId: event.id, sequence: event.sequence, duplicate };
    });
  }

  /** Decide a governed action through the Action Gateway (ADR 0005, ADR 0012). */
  async requestAction(runtime: RuntimeIdentity, body: unknown): Promise<RuntimeActionDecision> {
    const request = parseRuntimeActionRequest(body);
    const requestHash = createHash('sha256').update(canonicalManifest(request)).digest('hex');
    const organizationId = await this.leaseOrganization(runtime, request.correlation.runId);
    try {
      return await this.db.tenant(organizationId, async () => {
        await this.ownedLease(runtime, request.correlation.runId);
        const existing = await this.db.get(
          'SELECT * FROM agent_action_requests WHERE id=? AND organization_id=?',
          request.requestId,
          organizationId,
        );
        if (existing) {
          if (existing['request_hash'] !== requestHash)
            throw new ExecutionError(409, 'RUNTIME_ACTION_CONFLICT');
          return this.deps.gateway.storedDecision(existing);
        }
        const { run } = await this.runningStep(runtime, request.correlation);
        return this.deps.gateway.decide(runtime.id, run, request, requestHash);
      });
    } catch (error) {
      // The request id is taken by another organization's request.
      if (
        constraintKind(error) === 'unique' &&
        (error as { constraint?: string }).constraint === 'agent_action_requests_pkey'
      )
        throw new ExecutionError(409, 'RUNTIME_ACTION_CONFLICT');
      throw error;
    }
  }

  /**
   * Execute a control-plane-owned action the runtime was allowed or approved to perform
   * (ADR 0012). Single use: the dispatch is committed before the connector is called and a
   * retry returns the recorded outcome instead of calling the connector again.
   */
  async executeAction(runtime: RuntimeIdentity, body: unknown): Promise<RuntimeActionExecution> {
    const request = parseRuntimeActionExecuteRequest(body);
    const organizationId = await this.leaseOrganization(runtime, request.correlation.runId);
    const plan = await this.db.tenant(organizationId, async () => {
      const { run } = await this.runningStep(runtime, request.correlation);
      return this.deps.gateway.prepareExecution(run, request.requestId, request.correlation.stepId);
    });
    if (plan.kind === 'done') return plan.execution;
    // The connector call happens outside any transaction.
    const outcome = await this.deps.gateway.dispatch(plan.dispatch);
    return this.deps.gateway.completeExecution(plan.dispatch, outcome);
  }

  /** Issue the signed grant for an execution-runtime action (ADR 0013). */
  async issueGrant(runtime: RuntimeIdentity, body: unknown): Promise<SignedExecutionGrant> {
    const request = parseRuntimeActionExecuteRequest(body);
    const organizationId = await this.leaseOrganization(runtime, request.correlation.runId);
    return this.db.tenant(organizationId, async () => {
      const { run } = await this.runningStep(runtime, request.correlation);
      const { correlation } = request;
      return this.deps.gateway.issueGrant(
        run,
        request.requestId,
        {
          organizationId: correlation.organizationId,
          employeeId: correlation.employeeId,
          agentId: correlation.agentId,
          threadId: correlation.threadId,
          runId: correlation.runId,
          stepId: correlation.stepId,
          toolCallId: correlation.toolCallId,
        },
        runtime.id,
      );
    });
  }

  /**
   * Reserve tokens for one model call against the organization's spending limits (ADR 0021).
   * Only a running run whose lease this runtime holds may reserve.
   */
  async reserveModelTokens(
    runtime: RuntimeIdentity,
    body: unknown,
  ): Promise<RuntimeModelReservation> {
    const request = parseRuntimeModelReservationRequest(body);
    const organizationId = await this.leaseOrganization(runtime, request.correlation.runId);
    try {
      return await this.db.tenant(organizationId, async () => {
        const run = await this.runningRun(runtime, request.correlation);
        return this.deps.spending.reserve(run, runtime.id, request);
      });
    } catch (error) {
      // The reservation id is taken by another organization's reservation.
      if (
        constraintKind(error) === 'unique' &&
        (error as { constraint?: string }).constraint === 'model_usage_reservations_pkey'
      )
        throw new ExecutionError(409, 'MODEL_RESERVATION_CONFLICT');
      throw error;
    }
  }

  /**
   * The organization's model credential for a running run this runtime holds (ADR 0034). The
   * provider must be the one the run's signed manifest names, in organization-managed mode.
   * The key is resolved outside any transaction and returned only in this response.
   */
  async modelCredential(runtime: RuntimeIdentity, body: unknown): Promise<RuntimeModelCredential> {
    const request = parseRuntimeModelCredentialRequest(body);
    const { correlation } = request;
    const organizationId = await this.leaseOrganization(runtime, correlation.runId);
    const run = await this.db.tenant(organizationId, async () => {
      const { run: held } = await this.heldRun(runtime, correlation, ['RUNNING']);
      return held;
    });
    try {
      const secret = await this.deps.modelCredentials.forRun(
        { organizationId, runId: correlation.runId, agentId: run.agentId },
        run.model,
        request.provider,
        runtime.id,
      );
      return { provider: request.provider, apiKey: secret.reveal() };
    } catch (error) {
      if (error instanceof ModelCredentialRefused) throw new ExecutionError(409, error.code);
      throw error;
    }
  }

  /**
   * Record a model call's reported usage. Allowed after the run ended, so a call that finished
   * as its run was cancelled is still counted.
   */
  async settleModelTokens(
    runtime: RuntimeIdentity,
    body: unknown,
  ): Promise<RuntimeModelSettlement> {
    const request = parseRuntimeModelSettlementRequest(body);
    const organizationId = await this.leaseOrganization(runtime, request.correlation.runId);
    return this.db.tenant(organizationId, async () => {
      await this.ownedLease(runtime, request.correlation.runId);
      if (request.correlation.organizationId !== organizationId)
        throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
      return this.deps.spending.settle(organizationId, runtime.id, request);
    });
  }

  /** Lease, correlation and status checks for a run the runtime is working on. */
  private async runningRun(
    runtime: RuntimeIdentity,
    correlation: RuntimeCorrelation,
  ): Promise<Row> {
    const lease = await this.ownedLease(runtime, correlation.runId);
    const organizationId = String(lease['organization_id']);
    if (lease['state'] !== 'ACTIVE') throw new ExecutionError(409, 'RUN_TERMINAL');
    const run = (await this.db.get(
      'SELECT * FROM agent_runs WHERE id=? AND organization_id=?',
      correlation.runId,
      organizationId,
    ))!;
    if (
      run['thread_id'] !== correlation.threadId ||
      run['employee_id'] !== correlation.employeeId ||
      run['agent_id'] !== correlation.agentId ||
      correlation.organizationId !== organizationId
    )
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    if (run['status'] !== 'RUNNING') throw new ExecutionError(409, 'RUN_NOT_RUNNING');
    return run;
  }

  /**
   * For an artifact upload: the runtime holds the running run, and the step is one of its
   * running steps. Returns the tenant and thread the stored run belongs to.
   */
  async authorizeStep(
    runtime: RuntimeIdentity,
    correlation: RuntimeCorrelation & { stepId: string },
  ): Promise<{ organizationId: string; threadId: string }> {
    const organizationId = await this.leaseOrganization(runtime, correlation.runId);
    return this.db.tenant(organizationId, async () => {
      const run = await this.runningRun(runtime, correlation);
      const step = await this.db.get<{ status: string }>(
        'SELECT status FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?',
        correlation.stepId,
        correlation.runId,
        organizationId,
      );
      if (!step) throw new ExecutionError(404, 'STEP_NOT_FOUND');
      if (step.status !== 'RUNNING') throw new ExecutionError(409, 'STEP_NOT_RUNNING');
      return { organizationId, threadId: String(run['thread_id']) };
    });
  }

  /** Lease, correlation, run and step checks shared by action requests and executions. */
  private async runningStep(
    runtime: RuntimeIdentity,
    correlation: RuntimeActionRequest['correlation'],
  ): Promise<{ run: Row; lease: Row }> {
    const run = await this.runningRun(runtime, correlation);
    const lease = await this.ownedLease(runtime, correlation.runId);
    const organizationId = String(lease['organization_id']);
    const step = await this.db.get<{ status: string }>(
      'SELECT status FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?',
      correlation.stepId,
      String(run['id']),
      organizationId,
    );
    if (!step) throw new ExecutionError(404, 'STEP_NOT_FOUND');
    if (step.status !== 'RUNNING') throw new ExecutionError(409, 'STEP_NOT_RUNNING');
    return { run, lease };
  }

  private async claimQueued(
    runtime: RuntimeIdentity,
    nowMs: number,
  ): Promise<RuntimeClaimResponse | null> {
    const nowIso = new Date(nowMs).toISOString();
    const profiles = [...runtime.runtimeProfiles];
    const tenants = runtime.organizations === '*' ? null : [...runtime.organizations];
    const candidates = await this.db.all<{
      id: string;
      organization_id: string;
      leased: string | null;
    }>(
      `SELECT r.id, r.organization_id, l.run_id AS leased FROM agent_runs r
       LEFT JOIN agent_run_leases l ON l.run_id=r.id
       WHERE r.status='QUEUED' AND r.status_reason IS NULL AND r.runtime_sequence=0
       AND r.manifest_api_version='agents-foundry/v2'
       AND r.runtime_profile IN (${profiles.map(() => '?').join(',')})
       ${tenants ? `AND r.organization_id IN (${tenants.map(() => '?').join(',')})` : ''}
       AND (l.run_id IS NULL OR (l.state='ACTIVE' AND l.lease_expires_at < ?))
       ORDER BY r.created_at, r.seq LIMIT 20`,
      ...profiles,
      ...(tenants ?? []),
      nowIso,
    );
    for (const candidate of candidates) {
      const command = await this.submitCommand(candidate.organization_id, candidate.id, nowIso);
      if (!command) continue;
      const sessionId = randomUUID();
      const expires = new Date(nowMs + RUNTIME_LEASE_MS).toISOString();
      if (candidate.leased)
        await this.db.run(
          `UPDATE agent_run_leases SET runtime_id=?, session_id=?, last_command='run.submit', heartbeat_at=?,
           lease_expires_at=? WHERE run_id=? AND state='ACTIVE'`,
          runtime.id,
          sessionId,
          nowIso,
          expires,
          candidate.id,
        );
      else
        await this.db.run(
          `INSERT INTO agent_run_leases (run_id, organization_id, session_id, runtime_id, state, last_command,
           claimed_at, heartbeat_at, lease_expires_at) VALUES (?,?,?,?,'ACTIVE','run.submit',?,?,?)`,
          candidate.id,
          candidate.organization_id,
          sessionId,
          runtime.id,
          nowIso,
          nowIso,
          expires,
        );
      await this.deps.audit(
        runtime.id,
        'runtime.run.claimed',
        'agent_run',
        candidate.id,
        { runtimeId: runtime.id, sessionId },
        candidate.organization_id,
      );
      return { command, lease: { sessionId, runtimeSequence: 0, leaseExpiresAt: expires } };
    }
    return null;
  }

  /** A queued run whose manifest can no longer be verified is cancelled, never executed. */
  private async submitCommand(
    organizationId: string,
    runId: string,
    nowIso: string,
  ): Promise<RuntimeCommand | null> {
    try {
      return await this.execution.buildRunSubmitCommand(organizationId, runId);
    } catch (error) {
      const manifestProblem =
        error instanceof ExecutionError ||
        (error instanceof Error && /^MANIFEST_[A-Z_]+$/.test(error.message));
      if (!manifestProblem) throw error;
      const code =
        error.message === 'RUNTIME_MANIFEST_V2_REQUIRED' ? error.message : 'MANIFEST_INVALID';
      await this.execution.cancelRun(organizationId, runId, code, null);
      const lease = await this.db.get(
        "SELECT 1 FROM agent_run_leases WHERE run_id=? AND state='ACTIVE'",
        runId,
      );
      if (lease) await this.closeLease(runId, nowIso);
      return null;
    }
  }

  private async respond(lease: Row, command: RuntimeCommand): Promise<RuntimeClaimResponse> {
    const runId = String(lease['run_id']);
    const current = (await this.db.get<{ session_id: string; lease_expires_at: string }>(
      'SELECT session_id, lease_expires_at FROM agent_run_leases WHERE run_id=?',
      runId,
    ))!;
    const sequence = (await this.db.get<{ runtime_sequence: number }>(
      'SELECT runtime_sequence FROM agent_runs WHERE id=?',
      runId,
    ))!;
    return {
      command,
      lease: {
        sessionId: current.session_id,
        runtimeSequence: Number(sequence.runtime_sequence),
        leaseExpiresAt: current.lease_expires_at,
      },
    };
  }

  private async commandBase(organizationId: string, runId: string) {
    const run = (await this.db.get<{ employee_id: string; agent_id: string; thread_id: string }>(
      'SELECT employee_id, agent_id, thread_id FROM agent_runs WHERE id=? AND organization_id=?',
      runId,
      organizationId,
    ))!;
    return {
      protocol: RUNTIME_PROTOCOL_V1,
      commandId: randomUUID(),
      issuedAt: new Date().toISOString(),
      correlation: {
        organizationId,
        employeeId: run.employee_id,
        agentId: run.agent_id,
        threadId: run.thread_id,
        runId,
      },
    };
  }

  /**
   * Which organization a runtime's lease belongs to (platform scope: the run is not yet
   * attributed to a tenant). The same checks as `ownedLease`; the lease is checked again
   * inside the tenant transaction that acts on it.
   */
  private leaseOrganization(runtime: RuntimeIdentity, runId: string): Promise<string> {
    return this.db.platform(async () =>
      String((await this.ownedLease(runtime, runId))['organization_id']),
    );
  }

  /** The lease must belong to this runtime and to a tenant it serves; otherwise 403. */
  private async ownedLease(runtime: RuntimeIdentity, runId: string): Promise<Row> {
    const lease = await this.db.get('SELECT * FROM agent_run_leases WHERE run_id=?', runId);
    if (
      !lease ||
      lease['runtime_id'] !== runtime.id ||
      !servesOrganization(runtime, String(lease['organization_id']))
    )
      throw new ExecutionError(403, 'RUNTIME_LEASE_REQUIRED');
    return lease;
  }

  private async touchLease(runId: string, nowMs: number, lastCommand?: string): Promise<void> {
    await this.db.run(
      `UPDATE agent_run_leases SET heartbeat_at=?, lease_expires_at=?, last_command=COALESCE(?::text, last_command)
       WHERE run_id=? AND state='ACTIVE'`,
      new Date(nowMs).toISOString(),
      new Date(nowMs + RUNTIME_LEASE_MS).toISOString(),
      lastCommand ?? null,
      runId,
    );
  }

  private async closeLease(runId: string, nowIso: string): Promise<void> {
    await this.db.run(
      `UPDATE agent_run_leases SET state='CLOSED', closed_at=?, heartbeat_at=? WHERE run_id=? AND state='ACTIVE'`,
      nowIso,
      nowIso,
      runId,
    );
  }
}
