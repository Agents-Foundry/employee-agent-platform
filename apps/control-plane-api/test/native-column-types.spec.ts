import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { bootstrapDatabase, dropDatabase, roleUrl } from '../src/db/bootstrap.js';
import { POSTGRES_MIGRATIONS, migrate } from '../src/db/migrate.js';
import { PgStore } from '../src/db/pg-store.js';
import { TEST_ROLES } from './support/postgres-roles.js';

const BEFORE = POSTGRES_MIGRATIONS.filter((migration) => migration.version < 8);

describe('native column types (migration 0008)', () => {
  const adminUrl = () => inject('postgresAdminUrl');
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  /** A database migrated to release 7, with direct connections for each role. */
  async function atRelease7() {
    const database = `af_test_${randomBytes(8).toString('hex')}`;
    await bootstrapDatabase(adminUrl(), { database, ...TEST_ROLES });
    cleanup.push(() => dropDatabase(adminUrl(), database));
    // Not UTC, so neither the migration nor reads may depend on the server's time zone.
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      await admin.query(`ALTER DATABASE ${database} SET TimeZone = 'Asia/Kolkata'`);
    } finally {
      await admin.end();
    }
    const urls = {
      owner: roleUrl(adminUrl(), database, TEST_ROLES.owner),
      tenant: roleUrl(adminUrl(), database, TEST_ROLES.tenant),
      platform: roleUrl(adminUrl(), database, TEST_ROLES.platform),
    };
    expect(await migrate(urls.owner, BEFORE)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const platform = new pg.Client({ connectionString: urls.platform });
    await platform.connect();
    cleanup.push(() => platform.end());
    return { urls, platform };
  }

  async function connect(urls: { tenant: string; platform: string }) {
    const store = await PgStore.connect({ tenantUrl: urls.tenant, platformUrl: urls.platform });
    cleanup.push(() => store.close());
    return store;
  }

  it('keeps every instant and document, in time order, and reads them back as before', async () => {
    const { urls, platform } = await atRelease7();
    const users = [
      ['u-ms', '2026-03-01T10:00:00.123Z'],
      ['u-seconds', '2026-03-01T10:00:01Z'],
      // Earlier than u-ms although it sorted after it as text.
      ['u-offset', '2026-03-01T11:59:00+02:00'],
      // No offset: read as UTC, whatever the server's time zone.
      ['u-local', '2026-03-01 10:00:02'],
    ];
    for (const [id, createdAt] of users)
      await platform.query(
        'INSERT INTO users (id, email, display_name, created_at) VALUES ($1, $2, $3, $4)',
        [id, `${id}@example.org`, id, createdAt],
      );
    await platform.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'Alpha', 'alpha')`,
    );
    const metadata = '{ "zeta": [1, 2.5, "\\u00e9"], "alpha": {"nested": true} }';
    await platform.query(
      `INSERT INTO audit_events (id, organization_id, actor_id, event_type, resource_type, resource_id, metadata, created_at)
       VALUES ('audit-1', 'org-a', 'someone', 'test', 'test', 'r', $1, '2026-03-01T10:00:00.000Z')`,
      [metadata],
    );

    expect(await migrate(urls.owner, POSTGRES_MIGRATIONS.slice(0, 8))).toEqual([8]);
    const store = await connect(urls);
    const read = await store.platform(() =>
      store.all('SELECT id, created_at FROM users ORDER BY created_at'),
    );
    expect(read).toEqual([
      { id: 'u-offset', created_at: '2026-03-01T09:59:00.000Z' },
      { id: 'u-ms', created_at: '2026-03-01T10:00:00.123Z' },
      { id: 'u-seconds', created_at: '2026-03-01T10:00:01.000Z' },
      { id: 'u-local', created_at: '2026-03-01T10:00:02.000Z' },
    ]);
    const audit = await store.platform(() =>
      store.get("SELECT metadata FROM audit_events WHERE id='audit-1'"),
    );
    expect(typeof audit!['metadata']).toBe('string');
    expect(JSON.parse(String(audit!['metadata']))).toEqual(JSON.parse(metadata));
    // Organization defaults are still filled in, now as timestamps with millisecond precision.
    const organization = await store.platform(() =>
      store.get("SELECT created_at, updated_at FROM organizations WHERE id='org-a'"),
    );
    expect(organization!['created_at']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await store.platform(() =>
      store.run(`INSERT INTO organizations (id, name, slug) VALUES ('org-b', 'Beta', 'beta')`),
    );
    const beta = await store.platform(() =>
      store.get("SELECT created_at FROM organizations WHERE id='org-b'"),
    );
    expect(
      await store.platform(() =>
        store.get(
          "SELECT 1 AS found FROM organizations WHERE id='org-b' AND created_at=?",
          String(beta!['created_at']),
        ),
      ),
    ).toEqual({ found: 1 });
  });

  it('converts the columns it should and leaves signed text alone', async () => {
    const { urls } = await atRelease7();
    await migrate(urls.owner);
    const owner = new pg.Client({ connectionString: urls.owner });
    await owner.connect();
    cleanup.push(() => owner.end());
    const columns = (
      await owner.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
         WHERE c.table_schema='public' AND t.table_type='BASE TABLE'`,
      )
    ).rows;
    const type = (table: string, column: string) =>
      columns.find((item) => item.table_name === table && item.column_name === column)?.data_type;
    // Every timestamp but the migration bookkeeping's own.
    expect(
      columns
        .filter((item) => item.column_name.endsWith('_at') && item.data_type === 'text')
        .map((item) => `${item.table_name}.${item.column_name}`),
    ).toEqual(['schema_migrations.applied_at']);
    expect(columns.filter((item) => item.data_type === 'timestamp with time zone').length).toBe(94);
    for (const [table, column] of [
      ['agent_runs', 'task'],
      ['agent_events', 'payload'],
      ['audit_events', 'metadata'],
      ['organization_change_events', 'before_json'],
      ['provisioning_requests', 'body'],
      ['model_quality_results', 'failed_gates'],
    ] as const)
      expect(type(table, column)).toBe('jsonb');
    expect(columns.filter((item) => item.data_type === 'jsonb').length).toBe(16);
    for (const [table, column] of [
      ['agent_manifests', 'body'],
      ['agent_execution_grants', 'signed_grant'],
      ['alert_webhook_deliveries', 'body'],
      ['catalog_blueprint_versions', 'content'],
      ['messages', 'content'],
    ] as const)
      expect(type(table, column)).toBe('text');

    // Triggers that name converted columns still guard them.
    const triggers = (
      await owner.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[]) AND NOT tgisinternal`,
        [
          '{installation_identity_immutable,agent_runs_identity_immutable,agent_run_steps_identity_immutable,agent_run_leases_identity_immutable,connector_connections_identity_immutable}',
        ],
      )
    ).rows.map((row) => row.tgname);
    expect(triggers).toHaveLength(5);
    const detail = await owner.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name='agent_run_steps' AND column_name='detail'",
    );
    expect(detail.rows[0]!.column_default).toBe("'{}'::jsonb");
  });

  it('fails without changing anything when a stored value is not a timestamp', async () => {
    const { urls, platform } = await atRelease7();
    await platform.query(
      `INSERT INTO users (id, email, display_name, created_at) VALUES ('u', 'u@example.org', 'u', 'yesterday-ish')`,
    );
    await expect(migrate(urls.owner)).rejects.toThrow(/invalid input syntax for type timestamp/);
    const recorded = await platform.query('SELECT max(version) AS version FROM schema_migrations');
    expect(Number(recorded.rows[0].version)).toBe(7);
    const column = await platform.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='created_at'",
    );
    expect(column.rows[0].data_type).toBe('text');
  });

  it('refuses to read a timestamp JavaScript cannot represent', async () => {
    const { urls, platform } = await atRelease7();
    await migrate(urls.owner);
    await platform.query(
      `INSERT INTO users (id, email, display_name, created_at) VALUES ('u', 'u@example.org', 'u', 'infinity')`,
    );
    const store = await connect(urls);
    await expect(
      store.platform(() => store.get("SELECT created_at FROM users WHERE id='u'")),
    ).rejects.toThrow('TIMESTAMP_OUT_OF_RANGE');
  });
});
