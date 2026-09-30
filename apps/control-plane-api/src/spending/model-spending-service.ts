import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  Actor,
  ModelUsageReport,
  ModelUsageTotals,
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
import {
  DEFAULT_CURRENCY,
  ModelPriceService,
  costMicros,
  lockSpending,
  maxOutputWithin,
  recordChange,
  type Price,
} from './model-prices.js';
import { ModelBudgetAlertService, periodOf, type AlertScope } from './model-budget-alerts.js';

export { periodOf };

/** A call granted less output than this is not worth making: the reservation is denied. */
export const MIN_OUTPUT_TOKENS = 256;
/** Alert thresholds before an organization chooses its own; the migration's column default. */
export const DEFAULT_ALERT_THRESHOLDS = [80] as const;
const MAX_LIMIT = 1_000_000_000_000;
/** One billion units of any currency, in micros. */
const MAX_COST_LIMIT = 1_000_000_000_000_000;

const limit = z.number().int().positive().max(MAX_LIMIT).nullable();
const costLimit = z.number().int().positive().max(MAX_COST_LIMIT).nullable();
const budgetInput = z
  .object({
    monthlyTokenLimit: limit,
    runTokenLimit: limit,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    monthlyCostLimitMicros: costLimit.optional(),
    runCostLimitMicros: costLimit.optional(),
    alertThresholdsPercent: z
      .array(z.number().int().min(1).max(99))
      .max(5)
      .refine((values) => new Set(values).size === values.length, 'duplicate threshold')
      .optional(),
    version: z.number().int().min(0),
  })
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
/** The same in micros; calls without a price add nothing. */
const CHARGED_COST = `COALESCE(SUM(CASE WHEN status='SETTLED' THEN cost_micros ELSE reserved_cost_micros END),0)`;
const TOTALS = `${CHARGED} AS charged, ${CHARGED_COST} AS charged_cost, count(*) AS calls,
 count(*) FILTER (WHERE price_id IS NULL) AS unpriced`;

type Scope = 'MONTHLY' | 'RUN' | 'MONTHLY_COST' | 'RUN_COST';
const REASONS: Record<Scope | 'PRICE', string> = {
  MONTHLY: "The organization's monthly model token limit is reached.",
  RUN: "This run's model token limit is reached.",
  MONTHLY_COST: "The organization's monthly model cost limit is reached.",
  RUN_COST: "This run's model cost limit is reached.",
  PRICE: 'The organization limits model cost, and this model has no price.',
};

const MONTHLY_ALERTS: Partial<Record<Scope, AlertScope>> = {
  MONTHLY: 'MONTHLY_TOKENS',
  MONTHLY_COST: 'MONTHLY_COST',
};

/**
 * Organization model spending limits (ADR 0021) in tokens and, from per-model prices, in cost
 * (ADR 0022). Every model call a runtime makes is reserved here first and settled afterwards.
 * Limits are checked under a per-organization lock, so concurrent runs cannot both take the
 * last of a limit. Without a configured budget, calls are allowed and still recorded.
 */
export class ModelSpendingService {
  readonly prices: ModelPriceService;
  readonly alerts: ModelBudgetAlertService;

  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
    onAlert?: ConstructorParameters<typeof ModelBudgetAlertService>[3],
  ) {
    this.prices = new ModelPriceService(db, structure);
    this.alerts = new ModelBudgetAlertService(db, structure, audit, onAlert);
  }

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
    await lockSpending(this.db, organizationId);
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
    const runId = String(run['id']);
    const budget = this.mapBudget(await this.budgetRow(organizationId));
    const price = await this.prices.current(organizationId, request.provider, request.model);
    const deny = async (scope: Scope | 'PRICE', remaining: Record<string, number>) => {
      await this.audit(
        runtimeId,
        scope === 'PRICE' ? 'model.price.unavailable' : 'model.budget.exceeded',
        'agent_run',
        runId,
        {
          scope,
          period,
          provider: request.provider,
          model: request.model,
          requestedTokens: request.estimatedInputTokens + request.maxOutputTokens,
          ...remaining,
        },
        organizationId,
      );
      // The runtime protocol has one denial code; the reason and the audit say which limit.
      return {
        reservationId: request.reservationId,
        decision: 'DENIED' as const,
        code: 'MODEL_BUDGET_EXCEEDED' as const,
        reason: REASONS[scope],
      };
    };
    const costLimited =
      budget.monthlyCostLimitMicros !== null || budget.runCostLimitMicros !== null;
    if (costLimited && (!price || price.currency !== budget.currency)) return deny('PRICE', {});

    // Each limit allows some amount of output for this input; the tightest one decides.
    const month = await this.charged('period=?', organizationId, period);
    const thisRun = await this.charged('run_id=?', organizationId, runId);
    const fits: { scope: Scope; output: number; remaining: Record<string, number> }[] = [];
    const tokens = (scope: Scope, cap: number | null, used: number) => {
      if (cap === null) return;
      const left = cap - used;
      fits.push({
        scope,
        output: left - request.estimatedInputTokens,
        remaining: { remainingTokens: Math.max(0, left) },
      });
    };
    const cost = (scope: Scope, cap: number | null, used: number) => {
      if (cap === null) return;
      const left = cap - used;
      fits.push({
        scope,
        output: maxOutputWithin(price!, left, request.estimatedInputTokens),
        remaining: { remainingCostMicros: Math.max(0, left) },
      });
    };
    tokens('MONTHLY', budget.monthlyTokenLimit, month.tokens);
    tokens('RUN', budget.runTokenLimit, thisRun.tokens);
    cost('MONTHLY_COST', budget.monthlyCostLimitMicros, month.cost);
    cost('RUN_COST', budget.runCostLimitMicros, thisRun.cost);
    const tightest = fits.sort((a, b) => a.output - b.output)[0];
    const granted = Math.min(request.maxOutputTokens, tightest?.output ?? Number.POSITIVE_INFINITY);
    if (tightest && granted < Math.min(MIN_OUTPUT_TOKENS, request.maxOutputTokens)) {
      const denial = await deny(tightest.scope, tightest.remaining);
      // A monthly limit that refuses a call is reached, even with a little of it left.
      const reached = MONTHLY_ALERTS[tightest.scope];
      if (reached)
        await this.alerts.check({
          organizationId,
          actorId: runtimeId,
          period,
          budget,
          charged: month,
          reached,
          nowMs,
        });
      return denial;
    }

    await this.db.run(
      `INSERT INTO model_usage_reservations (id,organization_id,run_id,employee_id,agent_id,runtime_id,provider,model,
       period,reserved_tokens,max_output_tokens,status,request_hash,created_at,price_id,currency,reserved_cost_micros)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'RESERVED',?,?,?,?,?)`,
      request.reservationId,
      organizationId,
      runId,
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
      price?.id ?? null,
      price?.currency ?? null,
      price ? costMicros(price, request.estimatedInputTokens, granted) : null,
    );
    await this.checkAlerts(organizationId, runtimeId, period, budget, nowMs);
    return { reservationId: request.reservationId, decision: 'ALLOWED', maxOutputTokens: granted };
  }

  /**
   * Record a call's reported usage, once, costed at the price it was reserved under. The
   * reservation must belong to the run and runtime. Must run in the run's tenant scope.
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
    const price = row['price_id'] == null ? null : await this.priceOf(organizationId, row);
    await this.db.run(
      `UPDATE model_usage_reservations SET status='SETTLED', input_tokens=?, output_tokens=?, cost_micros=?, settled_at=?
       WHERE id=? AND organization_id=? AND status='RESERVED'`,
      request.inputTokens,
      request.outputTokens,
      price ? costMicros(price, request.inputTokens, request.outputTokens) : null,
      new Date(nowMs).toISOString(),
      request.reservationId,
      organizationId,
    );
    // Reported usage above the reservation can cross a threshold.
    await this.checkAlerts(
      organizationId,
      runtimeId,
      String(row['period']),
      this.mapBudget(await this.budgetRow(organizationId)),
      nowMs,
    );
    return { reservationId: request.reservationId, status: 'SETTLED' };
  }

  getBudget(actor: Actor): Promise<OrganizationModelBudget> {
    return this.asAdmin(actor, async () =>
      this.mapBudget(await this.budgetRow(actor.organizationId)),
    );
  }

  /**
   * Set or clear the limits. `version` is the current version (0 before the first budget).
   * Omitted optional fields keep their values. The currency is fixed once the
   * organization has set a price, so recorded costs never mix currencies.
   */
  setBudget(actor: Actor, raw: unknown): Promise<OrganizationModelBudget> {
    const input = budgetInput.parse(raw);
    return this.asAdmin(actor, async () => {
      await lockSpending(this.db, actor.organizationId);
      const before = this.mapBudget(await this.budgetRow(actor.organizationId));
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
      const currency = input.currency ?? before.currency;
      if (currency !== before.currency && (await this.prices.hasPriceHistory(actor.organizationId)))
        throw new OrganizationDomainError(409, 'MODEL_CURRENCY_FIXED');
      const values = [
        input.monthlyTokenLimit,
        input.runTokenLimit,
        currency,
        input.monthlyCostLimitMicros === undefined
          ? before.monthlyCostLimitMicros
          : input.monthlyCostLimitMicros,
        input.runCostLimitMicros === undefined
          ? before.runCostLimitMicros
          : input.runCostLimitMicros,
        `{${(input.alertThresholdsPercent ?? before.alertThresholdsPercent).join(',')}}`,
      ];
      const now = new Date().toISOString();
      if (before.version === 0)
        await this.db.run(
          `INSERT INTO organization_model_budgets (organization_id,monthly_token_limit,run_token_limit,currency,
           monthly_cost_limit_micros,run_cost_limit_micros,alert_thresholds,version,updated_by,updated_at)
           VALUES (?,?,?,?,?,?,?::smallint[],1,?,?)`,
          actor.organizationId,
          ...values,
          actor.id,
          now,
        );
      else
        await this.db.run(
          `UPDATE organization_model_budgets SET monthly_token_limit=?, run_token_limit=?, currency=?,
           monthly_cost_limit_micros=?, run_cost_limit_micros=?, alert_thresholds=?::smallint[], version=version+1, updated_by=?, updated_at=?
           WHERE organization_id=? AND version=?`,
          ...values,
          actor.id,
          now,
          actor.organizationId,
          input.version,
        );
      const after = this.mapBudget(await this.budgetRow(actor.organizationId));
      await recordChange(
        this.db,
        actor,
        'model_budget.updated',
        'model_budget',
        actor.organizationId,
        before.version === 0 ? null : before,
        after,
        now,
      );
      // A lowered limit or threshold can already be reached.
      await this.checkAlerts(
        actor.organizationId,
        actor.id,
        periodOf(Date.now()),
        after,
        Date.now(),
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
        `SELECT ${TOTALS},
         COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(CASE WHEN status='RESERVED' THEN reserved_tokens ELSE 0 END),0) AS unsettled
         FROM model_usage_reservations WHERE organization_id=? AND period=?`,
        organizationId,
        period,
      ))!;
      const byAgent = await this.db.all(
        `SELECT agent_id, ${TOTALS} FROM model_usage_reservations
         WHERE organization_id=? AND period=? GROUP BY agent_id ORDER BY charged DESC, agent_id`,
        organizationId,
        period,
      );
      const byModel = await this.db.all(
        `SELECT provider, model, ${TOTALS} FROM model_usage_reservations
         WHERE organization_id=? AND period=? GROUP BY provider, model ORDER BY charged DESC, provider, model`,
        organizationId,
        period,
      );
      const summary = this.mapTotals(totals);
      return {
        period,
        budget,
        ...summary,
        inputTokens: Number(totals['input']),
        outputTokens: Number(totals['output']),
        unsettledReservedTokens: Number(totals['unsettled']),
        remainingTokens:
          budget.monthlyTokenLimit === null
            ? null
            : Math.max(0, budget.monthlyTokenLimit - summary.chargedTokens),
        remainingCostMicros:
          budget.monthlyCostLimitMicros === null
            ? null
            : Math.max(0, budget.monthlyCostLimitMicros - summary.chargedCostMicros),
        byAgent: byAgent.map((row) => ({
          agentId: String(row['agent_id']),
          ...this.mapTotals(row),
        })),
        byModel: byModel.map((row) => ({
          provider: String(row['provider']),
          model: String(row['model']),
          ...this.mapTotals(row),
        })),
      };
    });
  }

  private async checkAlerts(
    organizationId: string,
    actorId: string,
    period: string,
    budget: OrganizationModelBudget,
    nowMs: number,
  ) {
    if (budget.monthlyTokenLimit === null && budget.monthlyCostLimitMicros === null) return;
    const charged = await this.charged('period=?', organizationId, period);
    await this.alerts.check({ organizationId, actorId, period, budget, charged, nowMs });
  }

  private async charged(where: string, organizationId: string, value: string) {
    const row = await this.db.get(
      `SELECT ${CHARGED} AS charged, ${CHARGED_COST} AS charged_cost FROM model_usage_reservations
       WHERE organization_id=? AND ${where}`,
      organizationId,
      value,
    );
    return { tokens: Number(row?.['charged'] ?? 0), cost: Number(row?.['charged_cost'] ?? 0) };
  }

  /** The price a reservation was made at. It must exist: prices are never deleted. */
  private async priceOf(organizationId: string, reservation: Row): Promise<Price> {
    const row = await this.db.get(
      'SELECT * FROM model_prices WHERE organization_id=? AND id=?',
      organizationId,
      String(reservation['price_id']),
    );
    if (!row) throw new Error('MODEL_PRICE_MISSING');
    return {
      id: String(row['id']),
      currency: String(row['currency']),
      inputMicrosPerMillion: Number(row['input_micros_per_million']),
      outputMicrosPerMillion: Number(row['output_micros_per_million']),
    };
  }

  private mapTotals(row: Row): ModelUsageTotals {
    return {
      chargedTokens: Number(row['charged']),
      chargedCostMicros: Number(row['charged_cost']),
      calls: Number(row['calls']),
      unpricedCalls: Number(row['unpriced']),
    };
  }

  private budgetRow(organizationId: string) {
    return this.db.get<{
      monthly_token_limit: string | null;
      run_token_limit: string | null;
      currency: string;
      monthly_cost_limit_micros: string | null;
      run_cost_limit_micros: string | null;
      alert_thresholds: (string | number)[];
      version: string;
      updated_by: string;
      updated_at: string;
    }>('SELECT * FROM organization_model_budgets WHERE organization_id=?', organizationId);
  }

  private mapBudget(
    row: Awaited<ReturnType<ModelSpendingService['budgetRow']>>,
  ): OrganizationModelBudget {
    const optional = (value: string | null | undefined) => (value == null ? null : Number(value));
    return {
      monthlyTokenLimit: optional(row?.monthly_token_limit),
      runTokenLimit: optional(row?.run_token_limit),
      currency: row?.currency ?? DEFAULT_CURRENCY,
      monthlyCostLimitMicros: optional(row?.monthly_cost_limit_micros),
      runCostLimitMicros: optional(row?.run_cost_limit_micros),
      alertThresholdsPercent: row
        ? row.alert_thresholds.map(Number)
        : [...DEFAULT_ALERT_THRESHOLDS],
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
