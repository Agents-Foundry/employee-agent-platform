import { z } from 'zod';
import type {
  Actor,
  ActionReconciliation,
  ActionReconciliationReason,
} from '@agents-foundry/contracts';
import type { Telemetry } from '../../../../packages/telemetry/src/index.js';
import type { PgStore, Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';
import type { OrganizationStructureService } from '../organization/structure-service.js';
import type { Audit } from './action-policy-service.js';
import { controlPlaneAction, type ChangeSet } from './action-registry.js';

export type ReconciliationReason = ActionReconciliationReason;
export type { ActionReconciliation };

/**
 * What an administrator sees of the request is the control plane's own one-line summary, the
 * one an approver saw. It is written from validated parameters and holds no credential, but
 * the parameters came from a model, so anything shaped like a credential is removed as well.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /[A-Za-z0-9+/_-]{40,}={0,2}/g,
];
export const MAX_RECONCILIATION_SUMMARY = 300;

export function redactSummary(text: string): string {
  let result = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  for (const shape of CREDENTIAL_SHAPES) result = result.replace(shape, '[redacted]');
  result = result.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return result.length > MAX_RECONCILIATION_SUMMARY
    ? `${result.slice(0, MAX_RECONCILIATION_SUMMARY - 1)}…`
    : result;
}

const SELECT_RECONCILIATIONS = `SELECT r.*, q.step_id, q.parameters, q.change_set, a.summary AS approval_summary,
  a.resource_type, a.resource_id
  FROM agent_action_reconciliations r
  LEFT JOIN agent_action_requests q ON q.id=r.request_id AND q.organization_id=r.organization_id
  LEFT JOIN approvals a ON a.id=q.approval_id AND a.organization_id=r.organization_id`;

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
          `${SELECT_RECONCILIATIONS} WHERE r.organization_id=?
           ORDER BY (r.state='REQUIRED') DESC, r.seq DESC LIMIT 200`,
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
          `${SELECT_RECONCILIATIONS} WHERE r.request_id=? AND r.organization_id=?`,
          requestId,
          actor.organizationId,
        ))!,
      );
    });
  }
}

function parse(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The target and summary of the original request. An approval recorded both when it was
 * created; otherwise they are written again from the stored, validated parameters. Anything
 * that cannot be written is left out rather than shown raw.
 */
function described(row: Row): Pick<ActionReconciliation, 'target' | 'summary'> {
  const handler = controlPlaneAction(String(row['action']));
  let target: ActionReconciliation['target'] = row['resource_type']
    ? { type: String(row['resource_type']), id: String(row['resource_id']) }
    : null;
  let summary = row['approval_summary'] ? String(row['approval_summary']) : null;
  const parameters = parse(row['parameters']);
  if (handler && parameters && typeof parameters === 'object') {
    const valid = handler.parameters.safeParse(parameters);
    if (valid.success) {
      try {
        target ??= handler.resource(valid.data as never);
        summary ??= handler.summary(
          valid.data as never,
          parse(row['change_set']) as ChangeSet | null,
        );
      } catch {
        // Left out: a summary that cannot be written is not replaced by the payload.
      }
    }
  }
  return {
    target: target ? { type: redactSummary(target.type), id: redactSummary(target.id) } : null,
    summary: summary ? redactSummary(summary) : null,
  };
}

function map(row: Row): ActionReconciliation {
  return {
    requestId: String(row['request_id']),
    runId: String(row['run_id']),
    threadId: String(row['thread_id']),
    stepId: row['step_id'] ? String(row['step_id']) : null,
    action: String(row['action']),
    ...described(row),
    reason: String(row['reason']) as ReconciliationReason,
    state: String(row['state']) as ActionReconciliation['state'],
    createdAt: String(row['created_at']),
    ...(row['resolved_by'] ? { resolvedBy: String(row['resolved_by']) } : {}),
    ...(row['resolved_at'] ? { resolvedAt: String(row['resolved_at']) } : {}),
    ...(row['note'] ? { note: String(row['note']) } : {}),
  };
}
