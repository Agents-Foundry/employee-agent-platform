import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  RuntimeActionExecution,
  RuntimeActionRequest,
  RuntimeClaimResponse,
  RuntimeCommand,
  RuntimeEventAck,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../../packages/contracts/src/runtime/v1/protocol.js';
import {
  parseRuntimeActionExecuteRequest,
  parseRuntimeActionRequest,
  parseRuntimeEvent,
} from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import type { ActionGateway } from '../actions/action-gateway.js';
import { ExecutionError, type ExecutionService } from '../execution/execution-service.js';
import { servesOrganization, type RuntimeIdentity } from './runtime-identity.js';

type Row = Record<string, SQLInputValue>;

/** A claimed run that never started can be reclaimed by another runtime after this. */
export const RUNTIME_LEASE_MS = 10 * 60_000;
/** A command delivered but not acted on is redelivered after this (runtime restart). */
export const COMMAND_REDELIVERY_MS = 60_000;

export interface RuntimeTransportDependencies {
  gateway: ActionGateway;
  audit: (
    actorId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    metadata: object,
    organizationId: string,
  ) => void;
}

/**
 * Control-plane side of the runtime transport (ADR 0011). Every method takes an already
 * authenticated runtime identity. Tenancy comes from the stored run and lease, never from
 * the runtime's message; a runtime can only act on runs it holds a lease for.
 */
export class RuntimeTransportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly execution: ExecutionService,
    private readonly deps: RuntimeTransportDependencies,
  ) {}

  /** Single-use nonces for signed requests; expired entries are purged opportunistically. */
  consumeNonce(runtimeId: string, nonce: string, expiresAt: number): boolean {
    this.db.prepare('DELETE FROM runtime_request_nonces WHERE expires_at < ?').run(Date.now());
    const inserted = this.db
      .prepare(
        'INSERT INTO runtime_request_nonces (runtime_id, nonce, expires_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      )
      .run(runtimeId, nonce, expiresAt);
    return inserted.changes === 1;
  }

  /**
   * Hand the runtime its next command: a cancellation for a run it holds, a resume for one of
   * its runs released by an approval, or a fresh queued run it is authorized to execute.
   */
  claim(runtime: RuntimeIdentity, nowMs = Date.now()): RuntimeClaimResponse | null {
    // Expired approvals cancel their runs first, so they are delivered as run.cancel below.
    this.deps.gateway.expireDue(nowMs);
    return this.transaction(() => {
      const nowIso = new Date(nowMs).toISOString();
      const held = this.db
        .prepare(
          `SELECT l.*, r.status, r.status_reason, r.runtime_sequence FROM agent_run_leases l
           JOIN agent_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
           WHERE l.runtime_id=? AND l.state='ACTIVE' ORDER BY l.claimed_at, l.rowid`,
        )
        .all(runtime.id) as Row[];
      for (const lease of held) {
        const organizationId = String(lease['organization_id']);
        const runId = String(lease['run_id']);
        const status = String(lease['status']);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
          this.closeLease(runId, nowIso);
          if (status === 'CANCELLED')
            return this.respond(lease, {
              ...this.commandBase(organizationId, runId),
              type: 'run.cancel',
              runId,
              reason: String(lease['status_reason'] ?? 'CANCELLED'),
            });
          continue;
        }
        if (!servesOrganization(runtime, organizationId)) continue;
        const redeliver =
          Date.parse(String(lease['heartbeat_at'])) + COMMAND_REDELIVERY_MS <= nowMs;
        if (status === 'QUEUED' && lease['status_reason'] === 'APPROVAL_GRANTED') {
          const approval = this.db
            .prepare(
              `SELECT id, decided_at FROM approvals WHERE run_id=? AND organization_id=? AND status='APPROVED'
               ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
            )
            .get(runId, organizationId) as { id: string; decided_at: string } | undefined;
          if (!approval) continue;
          const marker = `run.resume:${approval.id}`;
          if (lease['last_command'] === marker && !redeliver) continue;
          this.touchLease(runId, nowMs, marker);
          return this.respond(lease, {
            ...this.commandBase(organizationId, runId),
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
          const command = this.submitCommand(organizationId, runId, nowIso);
          if (!command) continue;
          this.touchLease(runId, nowMs, 'run.submit');
          return this.respond(lease, command);
        }
      }
      return this.claimQueued(runtime, nowMs);
    });
  }

  /** Record one runtime event for a run the runtime holds. */
  ingest(runtime: RuntimeIdentity, body: unknown, nowMs = Date.now()): RuntimeEventAck {
    const envelope = parseRuntimeEvent(body);
    return this.transaction(() => {
      const lease = this.ownedLease(runtime, envelope.runId);
      if (
        envelope.type === 'run.started' &&
        envelope.payload.runtimeSessionId !== lease['session_id']
      )
        throw new ExecutionError(409, 'RUNTIME_SESSION_MISMATCH');
      const { event, duplicate } = this.execution.ingestRuntimeEvent(
        String(lease['organization_id']),
        body,
      );
      if (lease['state'] === 'ACTIVE') {
        const run = this.db
          .prepare('SELECT status FROM agent_runs WHERE id=?')
          .get(envelope.runId) as { status: string };
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status))
          this.closeLease(envelope.runId, new Date(nowMs).toISOString());
        else this.touchLease(envelope.runId, nowMs);
      }
      return { eventId: event.id, sequence: event.sequence, duplicate };
    });
  }

  /** Decide a governed action through the Action Gateway (ADR 0005, ADR 0012). */
  requestAction(runtime: RuntimeIdentity, body: unknown): ReturnType<ActionGateway['decide']> {
    const request = parseRuntimeActionRequest(body);
    const requestHash = createHash('sha256').update(canonicalManifest(request)).digest('hex');
    return this.transaction(() => {
      const lease = this.ownedLease(runtime, request.correlation.runId);
      const organizationId = String(lease['organization_id']);
      const existing = this.db
        .prepare('SELECT * FROM agent_action_requests WHERE id=?')
        .get(request.requestId) as Row | undefined;
      if (existing) {
        if (
          existing['organization_id'] !== organizationId ||
          existing['request_hash'] !== requestHash
        )
          throw new ExecutionError(409, 'RUNTIME_ACTION_CONFLICT');
        return this.deps.gateway.storedDecision(existing);
      }
      const { run } = this.runningStep(runtime, request.correlation);
      return this.deps.gateway.decide(runtime.id, run, request, requestHash);
    });
  }

  /**
   * Execute a control-plane-owned action the runtime was allowed or approved to perform
   * (ADR 0012). Single use: the dispatch is committed before the connector is called and a
   * retry returns the recorded outcome instead of calling the connector again.
   */
  async executeAction(runtime: RuntimeIdentity, body: unknown): Promise<RuntimeActionExecution> {
    const request = parseRuntimeActionExecuteRequest(body);
    const plan = this.transaction(() => {
      const { run } = this.runningStep(runtime, request.correlation);
      return this.deps.gateway.prepareExecution(run, request.requestId, request.correlation.stepId);
    });
    if (plan.kind === 'done') return plan.execution;
    const outcome = await this.deps.gateway.dispatch(plan.dispatch);
    return this.transaction(() => this.deps.gateway.completeExecution(plan.dispatch, outcome));
  }

  /** Issue the signed grant for an execution-runtime action (ADR 0013). */
  issueGrant(runtime: RuntimeIdentity, body: unknown): SignedExecutionGrant {
    const request = parseRuntimeActionExecuteRequest(body);
    return this.transaction(() => {
      const { run } = this.runningStep(runtime, request.correlation);
      const { correlation } = request;
      return this.deps.gateway.issueGrant(run, request.requestId, {
        organizationId: correlation.organizationId,
        employeeId: correlation.employeeId,
        agentId: correlation.agentId,
        threadId: correlation.threadId,
        runId: correlation.runId,
        stepId: correlation.stepId,
        toolCallId: correlation.toolCallId,
      });
    });
  }

  /** Lease, correlation, run and step checks shared by action requests and executions. */
  private runningStep(
    runtime: RuntimeIdentity,
    correlation: RuntimeActionRequest['correlation'],
  ): { run: Row; lease: Row } {
    const lease = this.ownedLease(runtime, correlation.runId);
    const organizationId = String(lease['organization_id']);
    if (lease['state'] !== 'ACTIVE') throw new ExecutionError(409, 'RUN_TERMINAL');
    const run = this.db
      .prepare('SELECT * FROM agent_runs WHERE id=? AND organization_id=?')
      .get(correlation.runId, organizationId) as Row;
    if (
      run['thread_id'] !== correlation.threadId ||
      run['employee_id'] !== correlation.employeeId ||
      run['agent_id'] !== correlation.agentId ||
      correlation.organizationId !== organizationId
    )
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    if (run['status'] !== 'RUNNING') throw new ExecutionError(409, 'RUN_NOT_RUNNING');
    const step = this.db
      .prepare('SELECT status FROM agent_run_steps WHERE id=? AND run_id=? AND organization_id=?')
      .get(correlation.stepId, run['id'], organizationId) as { status: string } | undefined;
    if (!step) throw new ExecutionError(404, 'STEP_NOT_FOUND');
    if (step.status !== 'RUNNING') throw new ExecutionError(409, 'STEP_NOT_RUNNING');
    return { run, lease };
  }

  private claimQueued(runtime: RuntimeIdentity, nowMs: number): RuntimeClaimResponse | null {
    const nowIso = new Date(nowMs).toISOString();
    const profiles = [...runtime.runtimeProfiles];
    const tenants = runtime.organizations === '*' ? null : [...runtime.organizations];
    const candidates = this.db
      .prepare(
        `SELECT r.id, r.organization_id, l.run_id AS leased FROM agent_runs r
         LEFT JOIN agent_run_leases l ON l.run_id=r.id
         WHERE r.status='QUEUED' AND r.status_reason IS NULL AND r.runtime_sequence=0
         AND r.manifest_api_version='agents-foundry/v2'
         AND r.runtime_profile IN (${profiles.map(() => '?').join(',')})
         ${tenants ? `AND r.organization_id IN (${tenants.map(() => '?').join(',')})` : ''}
         AND (l.run_id IS NULL OR (l.state='ACTIVE' AND l.lease_expires_at < ?))
         ORDER BY r.created_at, r.rowid LIMIT 20`,
      )
      .all(...profiles, ...(tenants ?? []), nowIso) as {
      id: string;
      organization_id: string;
      leased: string | null;
    }[];
    for (const candidate of candidates) {
      const command = this.submitCommand(candidate.organization_id, candidate.id, nowIso);
      if (!command) continue;
      const sessionId = randomUUID();
      const expires = new Date(nowMs + RUNTIME_LEASE_MS).toISOString();
      if (candidate.leased)
        this.db
          .prepare(
            `UPDATE agent_run_leases SET runtime_id=?, session_id=?, last_command='run.submit', heartbeat_at=?,
             lease_expires_at=? WHERE run_id=? AND state='ACTIVE'`,
          )
          .run(runtime.id, sessionId, nowIso, expires, candidate.id);
      else
        this.db
          .prepare(
            `INSERT INTO agent_run_leases (run_id, organization_id, session_id, runtime_id, state, last_command,
             claimed_at, heartbeat_at, lease_expires_at) VALUES (?,?,?,?,'ACTIVE','run.submit',?,?,?)`,
          )
          .run(
            candidate.id,
            candidate.organization_id,
            sessionId,
            runtime.id,
            nowIso,
            nowIso,
            expires,
          );
      this.deps.audit(
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
  private submitCommand(
    organizationId: string,
    runId: string,
    nowIso: string,
  ): RuntimeCommand | null {
    try {
      return this.execution.buildRunSubmitCommand(organizationId, runId);
    } catch (error) {
      const manifestProblem =
        error instanceof ExecutionError ||
        (error instanceof Error && /^MANIFEST_[A-Z_]+$/.test(error.message));
      if (!manifestProblem) throw error;
      const code =
        error.message === 'RUNTIME_MANIFEST_V2_REQUIRED' ? error.message : 'MANIFEST_INVALID';
      this.execution.cancelRun(organizationId, runId, code, null);
      const lease = this.db
        .prepare("SELECT 1 FROM agent_run_leases WHERE run_id=? AND state='ACTIVE'")
        .get(runId);
      if (lease) this.closeLease(runId, nowIso);
      return null;
    }
  }

  private respond(lease: Row, command: RuntimeCommand): RuntimeClaimResponse {
    const runId = String(lease['run_id']);
    const current = this.db
      .prepare('SELECT session_id, lease_expires_at FROM agent_run_leases WHERE run_id=?')
      .get(runId) as { session_id: string; lease_expires_at: string };
    const sequence = this.db
      .prepare('SELECT runtime_sequence FROM agent_runs WHERE id=?')
      .get(runId) as { runtime_sequence: number };
    return {
      command,
      lease: {
        sessionId: current.session_id,
        runtimeSequence: Number(sequence.runtime_sequence),
        leaseExpiresAt: current.lease_expires_at,
      },
    };
  }

  private commandBase(organizationId: string, runId: string) {
    const run = this.db
      .prepare(
        'SELECT employee_id, agent_id, thread_id FROM agent_runs WHERE id=? AND organization_id=?',
      )
      .get(runId, organizationId) as { employee_id: string; agent_id: string; thread_id: string };
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

  /** The lease must belong to this runtime and to a tenant it serves; otherwise 403. */
  private ownedLease(runtime: RuntimeIdentity, runId: string): Row {
    const lease = this.db.prepare('SELECT * FROM agent_run_leases WHERE run_id=?').get(runId) as
      Row | undefined;
    if (
      !lease ||
      lease['runtime_id'] !== runtime.id ||
      !servesOrganization(runtime, String(lease['organization_id']))
    )
      throw new ExecutionError(403, 'RUNTIME_LEASE_REQUIRED');
    return lease;
  }

  private touchLease(runId: string, nowMs: number, lastCommand?: string): void {
    this.db
      .prepare(
        `UPDATE agent_run_leases SET heartbeat_at=?, lease_expires_at=?, last_command=COALESCE(?, last_command)
         WHERE run_id=? AND state='ACTIVE'`,
      )
      .run(
        new Date(nowMs).toISOString(),
        new Date(nowMs + RUNTIME_LEASE_MS).toISOString(),
        lastCommand ?? null,
        runId,
      );
  }

  private closeLease(runId: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE agent_run_leases SET state='CLOSED', closed_at=?, heartbeat_at=? WHERE run_id=? AND state='ACTIVE'`,
      )
      .run(nowIso, nowIso, runId);
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
}
