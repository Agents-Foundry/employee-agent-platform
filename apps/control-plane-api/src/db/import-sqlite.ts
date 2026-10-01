import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import pg from 'pg';
import { CONNECT_TIMEOUT_MS } from './pg-store.js';
import { migrateSqlite } from '../migrations/index.js';
import { migrate } from './migrate.js';

/**
 * Tables in foreign-key order. `select` overrides how rows are read from SQLite: the two
 * tables that gained `organization_id` in PostgreSQL take it from their parent, and catalog
 * versions gain their bundle schema.
 */
const TABLES: readonly { name: string; select?: string }[] = [
  { name: 'organizations' },
  { name: 'users' },
  { name: 'employees' },
  { name: 'organization_memberships' },
  { name: 'identities' },
  { name: 'login_transactions' },
  { name: 'password_credentials' },
  { name: 'account_password_credentials' },
  { name: 'auth_sessions' },
  { name: 'invitations' },
  { name: 'password_resets' },
  { name: 'account_link_invitations' },
  {
    // SQLite schema 011 predates bundle schemas; every version it holds is the first one.
    name: 'catalog_blueprint_versions',
    select: `SELECT *, 'agents-foundry.catalog-bundle/v1' AS bundle_schema FROM catalog_blueprint_versions ORDER BY rowid`,
  },
  { name: 'organization_agent_installations' },
  { name: 'agents' },
  { name: 'agent_manifests' },
  {
    name: 'agent_assignments',
    select:
      'SELECT s.*, a.organization_id FROM agent_assignments s JOIN agents a ON a.id=s.agent_id ORDER BY s.rowid',
  },
  { name: 'admin_agent_batches' },
  { name: 'provisioning_requests' },
  { name: 'conversations' },
  {
    name: 'messages',
    select:
      'SELECT m.*, c.organization_id FROM messages m JOIN conversations c ON c.id=m.conversation_id ORDER BY m.rowid',
  },
  { name: 'approvals' },
  { name: 'qa_runs' },
  { name: 'llm_key_bindings' },
  { name: 'audit_events' },
  { name: 'organizational_units' },
  { name: 'organization_change_events' },
  { name: 'job_families' },
  { name: 'job_disciplines' },
  { name: 'roles' },
  { name: 'job_levels' },
  { name: 'positions' },
  { name: 'organizational_unit_memberships' },
  { name: 'organization_domains' },
  { name: 'employee_position_assignments' },
  { name: 'agent_threads' },
  { name: 'agent_runs' },
  { name: 'agent_run_steps' },
  { name: 'agent_events' },
  { name: 'agent_artifacts' },
  { name: 'agent_run_leases' },
  { name: 'runtime_request_nonces' },
  { name: 'organization_connector_connections' },
  { name: 'agent_action_requests' },
  { name: 'organization_action_policies' },
  { name: 'agent_action_executions' },
  { name: 'agent_execution_grants' },
];

/** Self and circular references, inserted as NULL and filled in once every row exists. */
const DEFERRED: Record<string, string[]> = {
  organizational_units: ['parent_id', 'head_position_id'],
  positions: ['reports_to_position_id'],
};

const MAX_PARAMETERS = 30_000;

export interface ImportResult {
  tables: Record<string, number>;
}

/**
 * Import a SQLite control-plane database into an empty, migrated PostgreSQL database
 * (ADR 0018). The source is never modified: a consistent copy (`VACUUM INTO`) is brought to
 * SQLite schema 011 and read from.
 *
 * Runs as the schema owner in one transaction. For its duration it lifts FORCE ROW LEVEL
 * SECURITY and disables the domain triggers, because historical rows (archived units, retired
 * installations, finished runs) legitimately violate rules meant for new writes. Foreign keys,
 * unique and check constraints stay enforced. Nothing is visible until the transaction commits,
 * and every table's row count is verified before it does.
 */
export async function importSqlite(sqlitePath: string, ownerUrl: string): Promise<ImportResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'af-sqlite-import-'));
  const copy = join(workspace, 'snapshot.db');
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    source.prepare('VACUUM INTO ?').run(copy);
  } finally {
    source.close();
  }
  const sqlite = new DatabaseSync(copy);
  try {
    migrateSqlite(sqlite);
    await migrate(ownerUrl);
    const client = new pg.Client({
      connectionString: ownerUrl,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const { name } of TABLES)
        await client.query(
          `ALTER TABLE ${pg.escapeIdentifier(name)} NO FORCE ROW LEVEL SECURITY, DISABLE TRIGGER USER`,
        );
      const existing = await client.query('SELECT count(*) AS n FROM organizations');
      if (Number(existing.rows[0].n) !== 0) throw new Error('IMPORT_TARGET_NOT_EMPTY');
      const tables: Record<string, number> = {};
      for (const table of TABLES) tables[table.name] = await copyTable(sqlite, client, table);
      for (const [name, columns] of Object.entries(DEFERRED))
        await restore(sqlite, client, name, columns);
      for (const { name } of TABLES) {
        const count = await client.query(`SELECT count(*) AS n FROM ${pg.escapeIdentifier(name)}`);
        if (Number(count.rows[0].n) !== tables[name])
          throw new Error(`IMPORT_COUNT_MISMATCH: ${name}`);
      }
      for (const { name } of TABLES)
        await client.query(
          `ALTER TABLE ${pg.escapeIdentifier(name)} FORCE ROW LEVEL SECURITY, ENABLE TRIGGER USER`,
        );
      await client.query('COMMIT');
      return { tables };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  } finally {
    sqlite.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function columnsOf(client: pg.Client, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND is_identity='NO'
     ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function copyTable(
  sqlite: DatabaseSync,
  client: pg.Client,
  table: { name: string; select?: string },
): Promise<number> {
  const columns = await columnsOf(client, table.name);
  const rows = sqlite
    .prepare(table.select ?? `SELECT * FROM "${table.name}" ORDER BY rowid`)
    .all() as Record<string, SQLOutputValue>[];
  if (!rows.length) return 0;
  const missing = columns.filter((column) => !(column in rows[0]!));
  if (missing.length) throw new Error(`IMPORT_COLUMNS_MISSING: ${table.name}.${missing.join(',')}`);
  const deferred = new Set(DEFERRED[table.name] ?? []);
  const perBatch = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(deferred.has(column) ? null : value(row[column]));
        return `$${values.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${pg.escapeIdentifier(table.name)} (${columns.map((c) => pg.escapeIdentifier(c)).join(',')})
       VALUES ${tuples.join(',')}`,
      values,
    );
  }
  return rows.length;
}

async function restore(
  sqlite: DatabaseSync,
  client: pg.Client,
  table: string,
  columns: string[],
): Promise<void> {
  const rows = sqlite
    .prepare(
      `SELECT id, ${columns.join(',')} FROM "${table}" WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(' OR ')}`,
    )
    .all() as Record<string, SQLOutputValue>[];
  for (const row of rows)
    await client.query(
      `UPDATE ${pg.escapeIdentifier(table)} SET ${columns.map((c, i) => `${pg.escapeIdentifier(c)}=$${i + 2}`).join(',')} WHERE id=$1`,
      [row['id'], ...columns.map((column) => value(row[column]))],
    );
}

function value(input: SQLOutputValue | undefined): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input === 'bigint') return input.toString();
  if (input instanceof Uint8Array) throw new Error('IMPORT_BLOB_UNSUPPORTED');
  return input;
}
