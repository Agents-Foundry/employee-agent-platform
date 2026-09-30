import { z } from 'zod';
import type { Actor, ModelQualityOverview } from '@agents-foundry/contracts';
import type { PgStore, Row } from '../db/pg-store.js';
import { OrganizationDomainError } from '../organization/structure-service.js';
import { HISTORY_VERSION, trend, type HistoryRecord } from './quality-history.js';

const DAY_MS = 86_400_000;
const overviewQuery = z
  .object({
    days: z.coerce.number().int().min(7).max(730).default(182),
    blueprint: z
      .string()
      .regex(/^[a-z0-9.-]{1,120}(@[0-9A-Za-z.+-]{1,40})?$/)
      .optional(),
  })
  .strict();

/**
 * Model-quality results (ADR 0026): the scheduled evaluation's history (ADR 0025), imported by
 * an operator and shown to organization admins. The results describe catalog roles, so every
 * organization sees the same ones.
 */
export class ModelQualityService {
  constructor(private readonly db: PgStore) {}

  /**
   * Import validated history records in one transaction; records already imported are skipped.
   * Platform scope: only the operator's import writes results.
   */
  async import(
    records: readonly HistoryRecord[],
    nowMs = Date.now(),
  ): Promise<{ received: number; imported: number }> {
    const importedAt = new Date(nowMs).toISOString();
    const imported = await this.db.platform(async () => {
      let inserted = 0;
      for (const record of records) {
        const { changes } = await this.db.run(
          `INSERT INTO model_quality_results (run_id,run_at,commit_sha,provider,model,judge_model,blueprint,suite,task,
           trial,passed,score,pass_threshold,failed_gates,run_status,tokens,estimated_cost_usd,imported_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
          record.runId,
          record.runAt,
          record.commit,
          record.provider,
          record.model,
          record.judgeModel,
          record.blueprint,
          record.suite,
          record.task,
          record.trial,
          record.passed ? 1 : 0,
          record.score,
          record.passThreshold,
          JSON.stringify(record.failedGates),
          record.runStatus,
          record.tokens,
          record.estimatedCostUsd,
          importedAt,
        );
        inserted += changes;
      }
      return inserted;
    });
    return { received: records.length, imported };
  }

  /** Every series with a run in the window, optionally for one role or role version. */
  overview(actor: Actor, query: unknown, nowMs = Date.now()): Promise<ModelQualityOverview> {
    if (actor.role !== 'ADMIN') throw new OrganizationDomainError(403, 'ADMIN_ROLE_REQUIRED');
    const { days, blueprint } = overviewQuery.parse(query);
    const since = new Date(nowMs - days * DAY_MS).toISOString();
    return this.db.tenant(actor.organizationId, async () => {
      const filter = blueprint
        ? blueprint.includes('@')
          ? { sql: ' AND blueprint=?', value: blueprint }
          : { sql: " AND blueprint LIKE ? ESCAPE '\\'", value: `${escapeLike(blueprint)}@%` }
        : null;
      const rows = await this.db.all(
        `SELECT * FROM model_quality_results WHERE run_at>=?${filter?.sql ?? ''} ORDER BY run_at, trial`,
        since,
        ...(filter ? [filter.value] : []),
      );
      const last = await this.db.get('SELECT max(imported_at) AS at FROM model_quality_results');
      return {
        since,
        lastImportedAt: last?.['at'] == null ? null : String(last['at']),
        // Every series in the window, including models no longer scheduled: this is a record.
        series: trend(rows.map(toRecord), { currentOnly: false }),
      };
    });
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

function toRecord(row: Row): HistoryRecord {
  return {
    v: HISTORY_VERSION,
    runId: String(row['run_id']),
    runAt: String(row['run_at']),
    commit: row['commit_sha'] == null ? null : String(row['commit_sha']),
    provider: String(row['provider']),
    model: String(row['model']),
    judgeModel: String(row['judge_model']),
    blueprint: String(row['blueprint']),
    suite: String(row['suite']),
    task: String(row['task']),
    trial: Number(row['trial']),
    passed: row['passed'] === true,
    score: Number(row['score']),
    passThreshold: Number(row['pass_threshold']),
    failedGates: JSON.parse(String(row['failed_gates'])) as string[],
    runStatus: String(row['run_status']),
    tokens: Number(row['tokens']),
    estimatedCostUsd: row['estimated_cost_usd'] == null ? null : Number(row['estimated_cost_usd']),
  };
}
