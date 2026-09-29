import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Actor,
  ModelBudgetAlert,
  ModelBudgetAlertList,
  OrganizationModelBudget,
} from '@agents-foundry/contracts';
import type { Audit } from '../actions/action-policy-service.js';
import type { PgStore, Row } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import { recordChange } from './model-prices.js';

export type AlertScope = ModelBudgetAlert['scope'];
/** Reaching a limit always alerts, whatever thresholds are configured. */
export const LIMIT_REACHED = 100;

export const periodOf = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 7);

const periodQuery = z
  .object({
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict();
const alertId = z.string().uuid();

export interface AlertCheck {
  organizationId: string;
  /** Who caused the check: a runtime reserving or settling, or an admin changing limits. */
  actorId: string;
  period: string;
  budget: OrganizationModelBudget;
  /** The month's charged usage: settled plus unsettled reservations. */
  charged: { tokens: number; cost: number };
  /** A monthly limit that just refused a call, which counts as reached. */
  reached?: AlertScope;
  nowMs: number;
}

/**
 * Model budget alerts (ADR 0023). Whenever the month's charged usage changes, each monthly
 * limit is compared with the organization's thresholds; each threshold alerts once per month.
 * Alerts are shown to administrators and audited. They are not delivered outside the product.
 */
export class ModelBudgetAlertService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
  ) {}

  /** Raise the alerts the month's usage has reached. Must run in the tenant's scope. */
  async check(input: AlertCheck): Promise<void> {
    const { budget } = input;
    const limits: [AlertScope, number | null, number][] = [
      ['MONTHLY_TOKENS', budget.monthlyTokenLimit, input.charged.tokens],
      ['MONTHLY_COST', budget.monthlyCostLimitMicros, input.charged.cost],
    ];
    for (const [scope, limit, charged] of limits) {
      if (limit === null) continue;
      const thresholds = [...new Set([...budget.alertThresholdsPercent, LIMIT_REACHED])].filter(
        // Exact: charged / limit >= threshold / 100.
        (threshold) =>
          BigInt(charged) * 100n >= BigInt(threshold) * BigInt(limit) ||
          (threshold === LIMIT_REACHED && input.reached === scope),
      );
      for (const threshold of thresholds) await this.raise(input, scope, threshold, limit, charged);
    }
  }

  list(actor: Actor, query: unknown, nowMs = Date.now()): Promise<ModelBudgetAlertList> {
    const { period = periodOf(nowMs) } = periodQuery.parse(query);
    return this.asAdmin(actor, async () => {
      const rows = await this.db.all(
        'SELECT * FROM model_budget_alerts WHERE organization_id=? AND period=? ORDER BY seq DESC',
        actor.organizationId,
        period,
      );
      return { period, alerts: rows.map((row) => this.mapAlert(row)) };
    });
  }

  acknowledge(actor: Actor, rawId: unknown): Promise<ModelBudgetAlert> {
    const id = alertId.parse(rawId);
    return this.asAdmin(actor, async () => {
      const before = await this.row(actor.organizationId, id);
      if (!before) throw new OrganizationDomainError(404, 'MODEL_BUDGET_ALERT_NOT_FOUND');
      if (before['acknowledged_at'] != null)
        throw new OrganizationDomainError(409, 'MODEL_BUDGET_ALERT_ACKNOWLEDGED');
      const now = new Date().toISOString();
      const { changes } = await this.db.run(
        `UPDATE model_budget_alerts SET acknowledged_by=?, acknowledged_at=?
         WHERE id=? AND organization_id=? AND acknowledged_at IS NULL`,
        actor.id,
        now,
        id,
        actor.organizationId,
      );
      if (changes !== 1) throw new OrganizationDomainError(409, 'MODEL_BUDGET_ALERT_ACKNOWLEDGED');
      const after = this.mapAlert((await this.row(actor.organizationId, id))!);
      await recordChange(
        this.db,
        actor,
        'model_budget_alert.acknowledged',
        'model_budget_alert',
        id,
        this.mapAlert(before),
        after,
        now,
      );
      return after;
    });
  }

  private async raise(
    input: AlertCheck,
    scope: AlertScope,
    threshold: number,
    limit: number,
    charged: number,
  ) {
    const id = randomUUID();
    const currency = scope === 'MONTHLY_COST' ? input.budget.currency : null;
    const { changes } = await this.db.run(
      `INSERT INTO model_budget_alerts (id,organization_id,period,scope,threshold_percent,limit_value,
       charged_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (organization_id,period,scope,threshold_percent) DO NOTHING`,
      id,
      input.organizationId,
      input.period,
      scope,
      threshold,
      limit,
      charged,
      currency,
      new Date(input.nowMs).toISOString(),
    );
    if (changes === 1)
      await this.audit(
        input.actorId,
        'model.budget.alert',
        'model_budget_alert',
        id,
        { period: input.period, scope, thresholdPercent: threshold, limit, charged, currency },
        input.organizationId,
      );
  }

  private row(organizationId: string, id: string) {
    return this.db.get(
      'SELECT * FROM model_budget_alerts WHERE organization_id=? AND id=?',
      organizationId,
      id,
    );
  }

  private mapAlert(row: Row): ModelBudgetAlert {
    return {
      id: String(row['id']),
      period: String(row['period']),
      scope: row['scope'] as AlertScope,
      thresholdPercent: Number(row['threshold_percent']),
      limit: Number(row['limit_value']),
      charged: Number(row['charged_value']),
      currency: row['currency'] == null ? null : String(row['currency']),
      createdAt: String(row['created_at']),
      acknowledgedBy: row['acknowledged_by'] == null ? null : String(row['acknowledged_by']),
      acknowledgedAt: row['acknowledged_at'] == null ? null : String(row['acknowledged_at']),
    };
  }

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }
}
