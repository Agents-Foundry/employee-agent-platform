import { createHash } from 'node:crypto';
import pg from 'pg';
import { CONNECT_TIMEOUT_MS } from './pg-store.js';
import { baselineSql } from './migrations/0001-baseline.js';
import { modelSpendingSql } from './migrations/0002-model-spending.js';
import { modelPricesSql } from './migrations/0003-model-prices.js';
import { modelBudgetAlertsSql } from './migrations/0004-model-budget-alerts.js';

/** PostgreSQL migrations (ADR 0018). Released entries are immutable; add new versions only. */
export const POSTGRES_MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: 'baseline', sql: baselineSql },
  { version: 2, name: 'model-spending', sql: modelSpendingSql },
  { version: 3, name: 'model-prices', sql: modelPricesSql },
  { version: 4, name: 'model-budget-alerts', sql: modelBudgetAlertsSql },
];

export const SCHEMA_VERSION = POSTGRES_MIGRATIONS.at(-1)!.version;

/** Line endings are normalized so Windows and Linux checkouts record the same checksum. */
function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Applies pending migrations as the schema owner, one transaction each, under an advisory lock
 * so concurrent starts do not race. A changed released migration fails closed.
 */
export async function migrate(ownerUrl: string): Promise<number[]> {
  const client = new pg.Client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  const applied: number[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['agents-foundry:migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at text NOT NULL)`);
    await client.query('GRANT SELECT ON schema_migrations TO af_tenant, af_platform');
    const rows = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const existing = new Map(rows.rows.map((row) => [Number(row.version), row.checksum]));
    for (const migration of POSTGRES_MIGRATIONS) {
      const sum = checksum(migration.sql);
      const recorded = existing.get(migration.version);
      if (recorded !== undefined) {
        if (recorded !== sum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations VALUES ($1,$2,$3,$4)', [
        migration.version,
        migration.name,
        sum,
        new Date().toISOString(),
      ]);
      applied.push(migration.version);
    }
    for (const version of existing.keys())
      if (!POSTGRES_MIGRATIONS.some((migration) => migration.version === version))
        throw new Error('SCHEMA_NEWER_THAN_RELEASE');
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** The recorded migrations must match this release exactly; anything else fails closed. */
export async function assertSchemaCurrent(
  load: () => Promise<{ version: number; checksum: string }[]>,
): Promise<void> {
  let rows: { version: number; checksum: string }[];
  try {
    rows = await load();
  } catch {
    throw new Error('DATABASE_NOT_MIGRATED');
  }
  const matches =
    rows.length === POSTGRES_MIGRATIONS.length &&
    POSTGRES_MIGRATIONS.every(
      (migration, index) =>
        Number(rows[index]!.version) === migration.version &&
        rows[index]!.checksum === checksum(migration.sql),
    );
  if (!matches) throw new Error('DATABASE_SCHEMA_MISMATCH');
}
