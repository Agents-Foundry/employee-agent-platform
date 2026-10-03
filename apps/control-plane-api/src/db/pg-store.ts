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
  /** Run once the transaction has committed; dropped if it does not. */
  afterCommit: (() => void)[];
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
/**
 * A lost or refused connection: the server restarted, failed over or closed the session.
 * Nothing of the transaction was kept, so it is run again, a few times, over about three
 * seconds. The exception is a connection lost while COMMIT was in flight: the outcome is
 * unknown, so that is never retried here and the caller's own idempotency decides.
 */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
]);
const CONNECTION_MESSAGE =
  /Connection terminated|connection error|timeout exceeded when trying to connect|not queryable/i;
const CONNECTION_DELAYS_MS = [100, 300, 900, 1700];
const commitUnknown = new WeakSet<object>();

export function isConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === 'string' && CONNECTION_CODES.has(code)) ||
    (typeof message === 'string' && CONNECTION_MESSAGE.test(message))
  );
}
/** Unreachable servers fail fast instead of hanging requests or CLI runs. */
export const CONNECT_TIMEOUT_MS = 10_000;

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

const parseTimestamp = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, 'text');

/**
 * timestamptz as the ISO-8601 UTC strings the API writes (ADR 0028), such as
 * `2026-09-30T17:46:53.123Z`. Refuses values JavaScript cannot represent, such as `infinity`.
 */
function parseTimestamptz(value: string): string {
  const parsed = parseTimestamp(value) as Date;
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime()))
    throw new Error('TIMESTAMP_OUT_OF_RANGE');
  return parsed.toISOString();
}

/** jsonb as its JSON text: callers parse it themselves, as they did text columns. */
const jsonText = (value: string): string => value;

const parsers: Record<number, (value: string) => unknown> = {
  [pg.types.builtins.INT8]: parseInt8,
  [pg.types.builtins.TIMESTAMPTZ]: parseTimestamptz,
  [pg.types.builtins.JSONB]: jsonText,
  [pg.types.builtins.JSON]: jsonText,
};

const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    (format !== 'binary' && parsers[oid]) ||
    pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
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
  private readonly listeners = new Set<() => Promise<void>>();
  /** Told about every transaction that is run again, and why (telemetry). */
  onRetry: ((reason: 'serialization' | 'connection') => void) | undefined;

  private constructor(
    private readonly tenantPool: pg.Pool,
    private readonly platformPool: pg.Pool,
    private readonly listenerConfig: pg.ClientConfig,
  ) {}

  /**
   * Connects both roles and fails closed when the tenant role could see past row-level
   * security (superuser or BYPASSRLS).
   */
  static async connect(config: PgStoreConfig): Promise<PgStore> {
    const options = (connectionString: string): pg.ClientConfig => ({
      connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // Detects dead connections, including a listener's, instead of waiting on them.
      keepAlive: true,
      types,
      application_name: 'agents-foundry-control-plane',
    });
    const max = config.maxConnections ?? 10;
    const store = new PgStore(
      new pg.Pool({ ...options(config.tenantUrl), max }),
      new pg.Pool({ ...options(config.platformUrl), max }),
      options(config.platformUrl),
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

  /**
   * Run `effect` once the current transaction has committed, or now if there is none. For
   * things that must not happen for a transaction that is rolled back or run again, such as
   * counting it. Errors from `effect` are swallowed.
   */
  afterCommit(effect: () => void): void {
    const transaction = this.current.getStore();
    if (transaction) transaction.afterCommit.push(effect);
    else
      try {
        effect();
      } catch {
        // Never fails the caller.
      }
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

  /**
   * Opens a dedicated platform connection, outside the pools, listening on `channel`.
   * `onNotify` runs for each notification. `onLost` runs once when the connection fails or the
   * store closes; the returned function stops listening without calling it.
   */
  async listen(channel: string, onNotify: () => void, onLost: () => void): Promise<() => void> {
    if (!/^[a-z_]{1,63}$/.test(channel)) throw new DatabaseScopeError('INVALID_CHANNEL');
    if (this.closed) throw new DatabaseScopeError('DATABASE_CLOSED');
    const client = new pg.Client(this.listenerConfig);
    let active = true,
      ending: Promise<void> | undefined;
    // Stays listed until the connection has closed, so closing the store waits for it.
    const end = (lost: boolean) =>
      (ending ??= (async () => {
        active = false;
        if (lost) onLost();
        await client.end().catch(() => {
          // Already closed.
        });
        this.listeners.delete(lose);
      })());
    const lose = () => end(true);
    client.on('notification', (message) => {
      if (active && message.channel === channel) onNotify();
    });
    client.on('error', lose);
    client.on('end', lose);
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      active = false;
      await client.end().catch(() => {});
      throw error;
    }
    if (this.closed) {
      await end(false);
      throw new DatabaseScopeError('DATABASE_CLOSED');
    }
    this.listeners.add(lose);
    return () => void end(false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      ...[...this.listeners].map((lose) => lose()),
      this.tenantPool.end(),
      this.platformPool.end(),
    ]);
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
    let reconnects = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(scope, work);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) {
          this.onRetry?.('serialization');
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
          continue;
        }
        const delay = CONNECTION_DELAYS_MS[reconnects];
        if (
          delay === undefined ||
          this.closed ||
          !isConnectionFailure(error) ||
          commitUnknown.has(error as object)
        )
          throw error;
        reconnects += 1;
        this.onRetry?.('connection');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async attempt<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const pool = scope.kind === 'tenant' ? this.tenantPool : this.platformPool;
    const client = await pool.connect();
    // A connection lost while it is in use emits 'error' as well as failing the query. With no
    // listener Node would end the process; the failed query is what the caller handles.
    const lost = () => undefined;
    client.on('error', lost);
    let broken: Error | undefined;
    let committing = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (scope.kind === 'tenant')
        await client.query("SELECT set_config('app.organization_id', $1, true)", [
          scope.organizationId,
        ]);
      const transaction: Transaction = { scope, client, afterCommit: [] };
      const result = await this.current.run(transaction, work);
      committing = true;
      await client.query('COMMIT');
      for (const effect of transaction.afterCommit)
        try {
          effect();
        } catch {
          // An effect never undoes a committed transaction.
        }
      return result;
    } catch (error) {
      if (committing && isConnectionFailure(error) && error && typeof error === 'object')
        commitUnknown.add(error);
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        broken = rollback as Error;
      }
      throw error;
    } finally {
      client.off('error', lost);
      client.release(broken);
    }
  }
}
