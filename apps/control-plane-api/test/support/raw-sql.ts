import type { ControlPlaneDatabase } from '../../src/database.js';
import type { PgStore, Row, SqlParam } from '../../src/db/pg-store.js';

/**
 * Direct table access for tests that tamper with stored data to prove the control plane
 * fails closed. Each statement runs alone in the platform scope (no tenant filter), as the
 * raw SQLite handle did.
 */
export class RawSql {
  constructor(private readonly store: PgStore) {}

  prepare(sql: string) {
    const { store } = this;
    return {
      get: <T extends Row = Row>(...params: SqlParam[]) =>
        store.platform(() => store.get<T>(sql, ...params)),
      all: <T extends Row = Row>(...params: SqlParam[]) =>
        store.platform(() => store.all<T>(sql, ...params)),
      run: (...params: SqlParam[]) => store.platform(() => store.run(sql, ...params)),
    };
  }

  /** One or more statements without parameters. */
  async exec(sql: string): Promise<void> {
    await this.store.platform(() => this.store.run(sql));
  }
}

export const rawSql = (db: ControlPlaneDatabase): RawSql => new RawSql(db.store);
