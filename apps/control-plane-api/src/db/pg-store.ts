import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export type Row = Record<string, unknown>;
export type SqlParam = string | number | bigint | null | Buffer;

/**
 * Where a query runs (ADR 0018).
 * - `tenant`: the tenant role, which cannot bypass row-level security, with
 *   `app.organization_id` set for the transaction. Tenant tables show and accept only that
 *   organization's rows.
 * - `platform`: the platform role, for work that is cross-tenant by nature (sign-in, sessions,
 *   invitations, runtime claims, catalog registration). Its queries filter by organization
 *   explicitly.
 */
export type Scope = { kind: 'tenant'; organizationId: string } | { kind: 'platform' };

interface Transaction {
  scope: Scope;
  client: pg.PoolClient;
}

export class DatabaseScopeError extends Error {}

/** A PostgreSQL constraint failure, by kind; triggers raise their own codes as messages. */
export type ConstraintKind = 'unique' | 'check' | 'foreign_key' | 'not_null';

const CONSTRAINT_CODES: Record<string, ConstraintKind> = {
  '23505': 'unique',
  '23514': 'check',
  '23503': 'foreign_key',
  '23502': 'not_null',
};

export function constraintKind(error: unknown): ConstraintKind | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? CONSTRAINT_CODES[code] : undefined;
}

/** Serialization failures and deadlocks: the whole transaction is retried. */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 8;

const positional = new Map<string, string>();

/**
 * Rewrite `?` placeholders as `$1..$n`, skipping string literals, quoted identifiers and
 * comments. Values are always sent as parameters, never interpolated.
 */
export function toPositional(sql: string): string {
  const cached = positional.get(sql);
  if (cached !== undefined) return cached;
  let out = '';
  let index = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      const end = sql.indexOf(char, i + 1);
      if (end < 0) throw new Error('SQL_UNTERMINATED_QUOTE');
      out += sql.slice(i, end + 1);
      i = end;
    } else if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (char === '?') {
      out += `$${++index}`;
    } else {
      out += char;
    }
  }
  positional.set(sql, out);
  return out;
}

/** int8 (counts, epoch milliseconds) as numbers; refuses values beyond 2^53. */
function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('INTEGER_OUT_OF_RANGE');
  return parsed;
}

const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === 20 && format !== 'binary'
      ? parseInt8
      : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

export interface PgStoreConfig {
  /** Tenant role: must not bypass row-level security. */
  tenantUrl: string;
  /** Platform role: used only inside explicit platform scopes. */
  platformUrl: string;
  maxConnections?: number;
}

export class PgStore {
  private readonly current = new AsyncLocalStorage<Transaction>();
  private closed = false;

  private constructor(
    private readonly tenantPool: pg.Pool,
    private readonly platformPool: pg.Pool,
  ) {}

  /**
   * Connects both roles and fails closed when the tenant role could see past row-level
   * security (superuser or BYPASSRLS).
   */
  static async connect(config: PgStoreConfig): Promise<PgStore> {
    const options = (connectionString: string): pg.PoolConfig => ({
      connectionString,
      max: config.maxConnections ?? 10,
      types,
      application_name: 'agents-foundry-control-plane',
    });
    const store = new PgStore(
      new pg.Pool(options(config.tenantUrl)),
      new pg.Pool(options(config.platformUrl)),
    );
    try {
      const role = await store.tenantPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      const attributes = role.rows[0];
      if (!attributes || attributes.rolsuper || attributes.rolbypassrls)
        throw new Error('TENANT_ROLE_BYPASSES_ROW_SECURITY');
    } catch (error) {
      await store.close();
      throw error;
    }
    for (const pool of [store.tenantPool, store.platformPool])
      pool.on('error', () => {
        // An idle client failed (for example, the server restarted); the pool replaces it.
      });
    return store;
  }

  /** Runs `work` in one tenant transaction for `organizationId`. */
  tenant<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    if (typeof organizationId !== 'string' || !organizationId)
      throw new DatabaseScopeError('ORGANIZATION_REQUIRED');
    return this.scoped({ kind: 'tenant', organizationId }, work);
  }

  /** Runs `work` in one platform transaction. */
  platform<T>(work: () => Promise<T>): Promise<T> {
    return this.scoped({ kind: 'platform' }, work);
  }

  /** The scope of the current transaction, if any. */
  scope(): Scope | undefined {
    return this.current.getStore()?.scope;
  }

  async get<T extends Row = Row>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }

  async all<T extends Row = Row>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }> {
    return { changes: (await this.query(sql, params)).rowCount ?? 0 };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([this.tenantPool.end(), this.platformPool.end()]);
  }

  private query<T extends Row>(sql: string, params: SqlParam[]): Promise<pg.QueryResult<T>> {
    const transaction = this.current.getStore();
    // Fail closed: every query belongs to a declared scope.
    if (!transaction) throw new DatabaseScopeError('DATABASE_SCOPE_REQUIRED');
    return transaction.client.query<T>(toPositional(sql), params);
  }

  private async scoped<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const outer = this.current.getStore();
    if (outer) {
      // Nested scopes join the outer transaction. A platform transaction already sees every
      // organization; a tenant transaction never widens to another organization or to the
      // platform role.
      if (outer.scope.kind === 'platform') return work();
      if (scope.kind === 'tenant' && scope.organizationId === outer.scope.organizationId)
        return work();
      throw new DatabaseScopeError(
        scope.kind === 'platform' ? 'PLATFORM_SCOPE_FORBIDDEN' : 'WRONG_ORGANIZATION',
      );
    }
    if (this.closed) throw new DatabaseScopeError('DATABASE_CLOSED');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(scope, work);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code !== 'string' || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
      }
    }
  }

  private async attempt<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const pool = scope.kind === 'tenant' ? this.tenantPool : this.platformPool;
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (scope.kind === 'tenant')
        await client.query("SELECT set_config('app.organization_id', $1, true)", [
          scope.organizationId,
        ]);
      const result = await this.current.run({ scope, client }, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        broken = rollback as Error;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
