import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { ControlPlaneDatabase, type ControlPlaneDatabaseOptions } from '../../src/database.js';
import { cloneDatabase, dropDatabase, roleUrl } from '../../src/db/bootstrap.js';
import { PgStore } from '../../src/db/pg-store.js';
import { ManifestSigner } from '../../src/manifest-signing.js';
import { MemoryArtifactStore } from '../../src/artifacts/artifact-store.js';
import { TEMPLATE_DATABASE, TEST_ROLES } from './postgres-roles.js';

export type TestDatabaseOptions = Omit<ControlPlaneDatabaseOptions, 'store' | 'connection'>;

export interface TestStore {
  store: PgStore;
  /** Another connection to the same database, as a restarted API would open. */
  connect: () => Promise<PgStore>;
  /** Closes every connection and drops the database. */
  drop: () => Promise<void>;
  /** Direct connection URLs for each role, for database-level tests. */
  urls: { owner: string; tenant: string; platform: string };
}

/** A fresh, migrated PostgreSQL database for one test, cloned from the suite template. */
export async function testStore(): Promise<TestStore> {
  const adminUrl = inject('postgresAdminUrl');
  const database = `af_test_${randomBytes(8).toString('hex')}`;
  await cloneDatabase(adminUrl, database, TEMPLATE_DATABASE, TEST_ROLES.owner.name);
  const urls = {
    owner: roleUrl(adminUrl, database, TEST_ROLES.owner),
    tenant: roleUrl(adminUrl, database, TEST_ROLES.tenant),
    platform: roleUrl(adminUrl, database, TEST_ROLES.platform),
  };
  const stores: PgStore[] = [];
  const connect = async () => {
    const store = await PgStore.connect({
      tenantUrl: urls.tenant,
      platformUrl: urls.platform,
      maxConnections: 4,
    });
    stores.push(store);
    return store;
  };
  return {
    store: await connect(),
    connect,
    urls,
    drop: async () => {
      await Promise.all(stores.map((store) => store.close()));
      await dropDatabase(adminUrl, database);
    },
  };
}

/**
 * A control plane on its own database: seeded with the demo tenant unless `seedDemo` is
 * false, with an ephemeral signing key. `close()` also drops the database.
 */
export async function testDatabase(
  options: TestDatabaseOptions = {},
): Promise<ControlPlaneDatabase> {
  const { store, drop } = await testStore();
  try {
    const database = await ControlPlaneDatabase.open({
      seedDemo: true,
      signer: new ManifestSigner(),
      artifactStore: new MemoryArtifactStore(),
      ...options,
      store,
    });
    database.close = drop;
    return database;
  } catch (error) {
    await drop();
    throw error;
  }
}
