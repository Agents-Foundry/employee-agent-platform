import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Actor,
  ModelUsageReport,
  OrganizationModelBudget,
  RuntimeModelReservation,
  RuntimeModelReservationRequest,
  RuntimeModelSettlement,
  RuntimeModelSettlementRequest,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';
import type { Audit } from '../actions/action-policy-service.js';
import type { PgStore, Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';

/** A call granted less output than this is not worth making: the reservation is denied. */
export const MIN_OUTPUT_TOKENS = 256;
const MAX_LIMIT = 1_000_000_000_000;

const limit = z.number().int().positive().max(MAX_LIMIT).nullable();
const budgetInput = z
  .object({ monthlyTokenLimit: limit, runTokenLimit: limit, version: z.number().int().min(0) })
  .strict();
const usageQuery = z
  .object({
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict();

/** What counts against a limit: settled usage, or the reserved size until settlement. */
const CHARGED = `COALESCE(SUM(CASE WHEN status='SETTLED' THEN input_tokens+output_tokens ELSE reserved_tokens END),0)`;

export const periodOf = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 7);

/**
 * Organization model spending limits (ADR 0021). Every model call a runtime makes is reserved
 * here first and settled afterwards. Limits are checked under a per-organization lock, so
 * concurrent runs cannot both take the last tokens. Without a configured budget, calls are
 * allowed and still recorded.
 */
export class ModelSpendingService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
  ) {}

  /**
   * Decide a reservation for a run the caller has verified is running and leased by `runtimeId`.
   * Must run in the run's tenant scope.
   */
  async reserve(
    run: Row,
    runtimeId: string,
    request: RuntimeModelReservationRequest,
    nowMs = Date.now(),
  ): Promise<RuntimeModelReservation> {
    const organizationId = String(run['organization_id']);
    const requestHash = createHash('sha256').update(canonicalManifest(request)).digest('hex');
    await this.db.get(
      'SELECT pg_advisory_xact_lock(hashtext(?::text))',
      `model-spend:${organizationId}`,
    );
    const existing = await this.db.get(
      'SELECT request_hash, max_output_tokens FROM model_usage_reservations WHERE id=? AND organization_id=?',
      request.reservationId,
      organizationId,
    );
    if (existing) {
      if (existing['request_hash'] !== requestHash)
        throw new ExecutionError(409, 'MODEL_RESERVATION_CONFLICT');
      return {
        reservationId: request.reservationId,
        decision: 'ALLOWED',
        maxOutputTokens: Number(existing['max_output_tokens']),
      };
    }
    const period = periodOf(nowMs);
    const budget = await this.budgetRow(organizationId);
    const remaining: { scope: 'MONTHLY' | 'RUN'; tokens: number }[] = [];
    if (budget?.monthly_token_limit != null) {
      const used = await this.charged('period=?', organizationId, period);
      remaining.push({ scope: 'MONTHLY', tokens: Number(budget.monthly_token_limit) - used });
    }
    if (budget?.run_token_limit != null) {
      const used = await this.charged('run_id=?', organizationId, String(run['id']));
      remaining.push({ scope: 'RUN', tokens: Number(budget.run_token_limit) - used });
    }
    const tightest = remaining.sort((a, b) => a.tokens - b.tokens)[0];
    const granted = Math.min(
      request.maxOutputTokens,
      tightest ? tightest.tokens - request.estimatedInputTokens : Number.MAX_SAFE_INTEGER,
    );
    if (tightest && granted < Math.min(MIN_OUTPUT_TOKENS, request.maxOutputTokens)) {
      const reason =
        tightest.scope === 'MONTHLY'
          ? "The organization's monthly model token limit is reached."
          : "This run's model token limit is reached.";
      await this.audit(
        runtimeId,
        'model.budget.exceeded',
        'agent_run',
        String(run['id']),
        {
          scope: tightest.scope,
          period,
          provider: request.provider,
          model: request.model,
          requestedTokens: request.estimatedInputTokens + request.maxOutputTokens,
          remainingTokens: Math.max(0, tightest.tokens),
        },
        organizationId,
      );
      return {
        reservationId: request.reservationId,
        decision: 'DENIED',
        code: 'MODEL_BUDGET_EXCEEDED',
        reason,
      };
    }
    await this.db.run(
      `INSERT INTO model_usage_reservations (id,organization_id,run_id,employee_id,agent_id,runtime_id,provider,model,
       period,reserved_tokens,max_output_tokens,status,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'RESERVED',?,?)`,
      request.reservationId,
      organizationId,
      String(run['id']),
      String(run['employee_id']),
      String(run['agent_id']),
      runtimeId,
      request.provider,
      request.model,
      period,
      request.estimatedInputTokens + granted,
      granted,
      requestHash,
      new Date(nowMs).toISOString(),
    );
    return { reservationId: request.reservationId, decision: 'ALLOWED', maxOutputTokens: granted };
  }

  /**
   * Record a call's reported usage, once. The reservation must belong to the run and runtime.
   * Must run in the run's tenant scope.
   */
  async settle(
    organizationId: string,
    runtimeId: string,
    request: RuntimeModelSettlementRequest,
    nowMs = Date.now(),
  ): Promise<RuntimeModelSettlement> {
    const row = await this.db.get(
      'SELECT * FROM model_usage_reservations WHERE id=? AND organization_id=?',
      request.reservationId,
      organizationId,
    );
    if (!row || row['run_id'] !== request.correlation.runId || row['runtime_id'] !== runtimeId)
      throw new ExecutionError(404, 'MODEL_RESERVATION_NOT_FOUND');
    if (row['status'] === 'SETTLED') {
      if (
        Number(row['input_tokens']) !== request.inputTokens ||
        Number(row['output_tokens']) !== request.outputTokens
      )
        throw new ExecutionError(409, 'MODEL_RESERVATION_SETTLED');
      return { reservationId: request.reservationId, status: 'SETTLED' };
    }
    await this.db.run(
      `UPDATE model_usage_reservations SET status='SETTLED', input_tokens=?, output_tokens=?, settled_at=?
       WHERE id=? AND organization_id=? AND status='RESERVED'`,
      request.inputTokens,
      request.outputTokens,
      new Date(nowMs).toISOString(),
      request.reservationId,
      organizationId,
    );
    return { reservationId: request.reservationId, status: 'SETTLED' };
  }

  getBudget(actor: Actor): Promise<OrganizationModelBudget> {
    return this.asAdmin(actor, async () =>
      this.mapBudget(await this.budgetRow(actor.organizationId)),
    );
  }

  /** Set or clear the limits. `version` is the current version (0 before the first budget). */
  setBudget(actor: Actor, raw: unknown): Promise<OrganizationModelBudget> {
    const input = budgetInput.parse(raw);
    return this.asAdmin(actor, async () => {
      const before = this.mapBudget(await this.budgetRow(actor.organizationId));
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
      const now = new Date().toISOString();
      if (before.version === 0)
        await this.db.run(
          `INSERT INTO organization_model_budgets (organization_id,monthly_token_limit,run_token_limit,version,updated_by,updated_at)
           VALUES (?,?,?,1,?,?)`,
          actor.organizationId,
          input.monthlyTokenLimit,
          input.runTokenLimit,
          actor.id,
          now,
        );
      else
        await this.db.run(
          `UPDATE organization_model_budgets SET monthly_token_limit=?, run_token_limit=?, version=version+1,
           updated_by=?, updated_at=? WHERE organization_id=? AND version=?`,
          input.monthlyTokenLimit,
          input.runTokenLimit,
          actor.id,
          now,
          actor.organizationId,
          input.version,
        );
      const after = this.mapBudget(await this.budgetRow(actor.organizationId));
      await this.db.run(
        `INSERT INTO organization_change_events (id,organization_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        actor.organizationId,
        actor.id,
        'model_budget.updated',
        'model_budget',
        actor.organizationId,
        before.version === 0 ? null : JSON.stringify(before),
        JSON.stringify(after),
        randomUUID(),
        now,
      );
      return after;
    });
  }

  /** Usage for one UTC month (the current one by default), with totals by agent and model. */
  usage(actor: Actor, query: unknown, nowMs = Date.now()): Promise<ModelUsageReport> {
    const { period = periodOf(nowMs) } = usageQuery.parse(query);
    return this.asAdmin(actor, async () => {
      const organizationId = actor.organizationId;
      const budget = this.mapBudget(await this.budgetRow(organizationId));
      const totals = (await this.db.get(
        `SELECT ${CHARGED} AS charged, count(*) AS calls,
         COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(CASE WHEN status='RESERVED' THEN reserved_tokens ELSE 0 END),0) AS unsettled
         FROM model_usage_reservations WHERE organization_id=? AND period=?`,
        organizationId,
        period,
      ))!;
      const byAgent = await this.db.all(
        `SELECT agent_id, ${CHARGED} AS charged, count(*) AS calls FROM model_usage_reservations
         WHERE organization_id=? AND period=? GROUP BY agent_id ORDER BY charged DESC, agent_id`,
        organizationId,
        period,
      );
      const byModel = await this.db.all(
        `SELECT provider, model, ${CHARGED} AS charged, count(*) AS calls FROM model_usage_reservations
         WHERE organization_id=? AND period=? GROUP BY provider, model ORDER BY charged DESC, provider, model`,
        organizationId,
        period,
      );
      const charged = Number(totals['charged']);
      return {
        period,
        budget,
        chargedTokens: charged,
        calls: Number(totals['calls']),
        inputTokens: Number(totals['input']),
        outputTokens: Number(totals['output']),
        unsettledReservedTokens: Number(totals['unsettled']),
        remainingTokens:
          budget.monthlyTokenLimit === null
            ? null
            : Math.max(0, budget.monthlyTokenLimit - charged),
        byAgent: byAgent.map((row) => ({
          agentId: String(row['agent_id']),
          chargedTokens: Number(row['charged']),
          calls: Number(row['calls']),
        })),
        byModel: byModel.map((row) => ({
          provider: String(row['provider']),
          model: String(row['model']),
          chargedTokens: Number(row['charged']),
          calls: Number(row['calls']),
        })),
      };
    });
  }

  private async charged(where: string, organizationId: string, value: string): Promise<number> {
    const row = await this.db.get(
      `SELECT ${CHARGED} AS charged FROM model_usage_reservations WHERE organization_id=? AND ${where}`,
      organizationId,
      value,
    );
    return Number(row?.['charged'] ?? 0);
  }

  private budgetRow(organizationId: string) {
    return this.db.get<{
      monthly_token_limit: string | null;
      run_token_limit: string | null;
      version: string;
      updated_by: string;
      updated_at: string;
    }>('SELECT * FROM organization_model_budgets WHERE organization_id=?', organizationId);
  }

  private mapBudget(
    row: Awaited<ReturnType<ModelSpendingService['budgetRow']>>,
  ): OrganizationModelBudget {
    return {
      monthlyTokenLimit: row?.monthly_token_limit == null ? null : Number(row.monthly_token_limit),
      runTokenLimit: row?.run_token_limit == null ? null : Number(row.run_token_limit),
      version: row ? Number(row.version) : 0,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }
}
