import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import type { Telemetry } from '../../../../packages/telemetry/src/index.js';
import type { PgStore, Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';
import type { OrganizationStructureService } from '../organization/structure-service.js';
import type { Audit } from './action-policy-service.js';

export type ReconciliationReason = 'CONNECTOR_OUTCOME_UNKNOWN' | 'DISPATCH_INTERRUPTED';

export interface ActionReconciliation {
  requestId: string;
  runId: string;
  threadId: string;
  action: string;
  reason: ReconciliationReason;
  state: 'REQUIRED' | 'APPLIED' | 'NOT_APPLIED';
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
}

const resolutionSchema = z
  .object({
    resolution: z.enum(['APPLIED', 'NOT_APPLIED']),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * Governed writes whose outcome nobody knows (ADR 0036). The control plane never guesses: it
 * records that a person must check the external system, and until they have, it does not send
 * the same write again. An administrator of the organization resolves each one.
 */
export class ActionReconciliationService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
    private readonly telemetry: Telemetry,
  ) {}

  /**
   * Whether a write of `action` must wait for a reconciliation: one is open for this thread,
   * or for this exact payload anywhere in the organization. Caller's tenant transaction.
   */
  async blocks(
    organizationId: string,
    threadId: string,
    action: string,
    payloadDigest: string,
  ): Promise<boolean> {
    return Boolean(
      await this.db.get(
        `SELECT 1 AS found FROM agent_action_reconciliations
         WHERE organization_id=? AND action=? AND state='REQUIRED'
         AND (thread_id=? OR payload_digest=?) LIMIT 1`,
        organizationId,
        action,
        threadId,
        payloadDigest,
      ),
    );
  }

  /** Record that an execution's outcome is unknown. Caller's tenant transaction. */
  async require(input: {
    organizationId: string;
    requestId: string;
    runId: string;
    agentId: string;
    action: string;
    payloadDigest: string;
    reason: ReconciliationReason;
  }): Promise<void> {
    const run = await this.db.get<{ thread_id: string }>(
      'SELECT thread_id FROM agent_runs WHERE id=? AND organization_id=?',
      input.runId,
      input.organizationId,
    );
    if (!run) return;
    const inserted = await this.db.run(
      `INSERT INTO agent_action_reconciliations (request_id,organization_id,thread_id,run_id,action,
       payload_digest,reason,state,created_at) VALUES (?,?,?,?,?,?,?,'REQUIRED',?)
       ON CONFLICT (request_id) DO NOTHING`,
      input.requestId,
      input.organizationId,
      run.thread_id,
      input.runId,
      input.action,
      input.payloadDigest,
      input.reason,
      new Date().toISOString(),
    );
    if (inserted.changes !== 1) return;
    await this.audit(
      input.agentId,
      'action.reconciliation.required',
      'agent_run',
      input.runId,
      { action: input.action, requestId: input.requestId, reason: input.reason },
      input.organizationId,
    );
    this.db.afterCommit(() =>
      this.telemetry.count('af_action_reconciliations_total', {
        action: input.action,
        event: 'required',
      }),
    );
  }

  /** The organization's reconciliations, open ones first. Administrators only. */
  list(actor: Actor): Promise<ActionReconciliation[]> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return (
        await this.db.all(
          `SELECT * FROM agent_action_reconciliations WHERE organization_id=?
           ORDER BY (state='REQUIRED') DESC, seq DESC LIMIT 200`,
          actor.organizationId,
        )
      ).map(map);
    });
  }

  /**
   * An administrator says what the external system shows: the write is there (`APPLIED`) or
   * it is not (`NOT_APPLIED`, after which it may be requested again). Decided once.
   */
  resolve(actor: Actor, requestId: string, raw: unknown): Promise<ActionReconciliation> {
    const input = resolutionSchema.parse(raw);
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      const row = await this.db.get(
        'SELECT * FROM agent_action_reconciliations WHERE request_id=? AND organization_id=? FOR UPDATE',
        requestId,
        actor.organizationId,
      );
      if (!row) throw new ExecutionError(404, 'RECONCILIATION_NOT_FOUND');
      if (row['state'] !== 'REQUIRED') throw new ExecutionError(409, 'RECONCILIATION_RESOLVED');
      await this.db.run(
        `UPDATE agent_action_reconciliations SET state=?, resolved_by=?, resolved_at=?, note=?
         WHERE request_id=? AND organization_id=? AND state='REQUIRED'`,
        input.resolution,
        actor.id,
        new Date().toISOString(),
        input.note ?? null,
        requestId,
        actor.organizationId,
      );
      await this.audit(
        actor.id,
        'action.reconciliation.resolved',
        'agent_run',
        String(row['run_id']),
        { action: String(row['action']), requestId, resolution: input.resolution },
        actor.organizationId,
      );
      this.db.afterCommit(() =>
        this.telemetry.count('af_action_reconciliations_total', {
          action: String(row['action']),
          event: input.resolution.toLowerCase(),
        }),
      );
      return map(
        (await this.db.get(
          'SELECT * FROM agent_action_reconciliations WHERE request_id=? AND organization_id=?',
          requestId,
          actor.organizationId,
        ))!,
      );
    });
  }
}

function map(row: Row): ActionReconciliation {
  return {
    requestId: String(row['request_id']),
    runId: String(row['run_id']),
    threadId: String(row['thread_id']),
    action: String(row['action']),
    reason: String(row['reason']) as ReconciliationReason,
    state: String(row['state']) as ActionReconciliation['state'],
    createdAt: String(row['created_at']),
    ...(row['resolved_by'] ? { resolvedBy: String(row['resolved_by']) } : {}),
    ...(row['resolved_at'] ? { resolvedAt: String(row['resolved_at']) } : {}),
    ...(row['note'] ? { note: String(row['note']) } : {}),
  };
}
