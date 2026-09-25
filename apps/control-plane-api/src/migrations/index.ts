import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { organizationStructureSql } from './001-organization-structure.js';
import { jobArchitectureSql } from './002-job-architecture.js';
import { profilesIdentitiesSql } from './003-profiles-identities.js';
import { accountLinkingSql } from './004-account-linking.js';
import { unitHeadsMembershipDatesSql } from './005-unit-heads-membership-dates.js';
import { agentExecutionSql } from './006-agent-execution.js';
import { agentCatalogSql } from './007-agent-catalog.js';
import { runtimeTransportSql } from './008-runtime-transport.js';

export function migrateOrganization(
  db: DatabaseSync,
  throughVersion = Number.POSITIVE_INFINITY,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const migrations = [
    { version: 1, name: 'organization-structure', sql: organizationStructureSql },
    { version: 2, name: 'job-architecture', sql: jobArchitectureSql },
    { version: 3, name: 'profiles-identities', sql: profilesIdentitiesSql },
    { version: 4, name: 'account-linking', sql: accountLinkingSql },
    { version: 5, name: 'unit-heads-membership-dates', sql: unitHeadsMembershipDatesSql },
    { version: 6, name: 'agent-execution', sql: agentExecutionSql },
    { version: 7, name: 'agent-catalog', sql: agentCatalogSql },
    { version: 8, name: 'runtime-transport', sql: runtimeTransportSql },
  ];
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    // SQLite cannot rebuild a referenced table while foreign-key enforcement is enabled.
    // This one migration runs on the same synchronous connection and checks all FKs before commit.
    if (migration.version === 4) db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = db
        .prepare('SELECT checksum FROM schema_migrations WHERE version=?')
        .get(migration.version);
      if (applied && applied['checksum'] !== checksum)
        throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      if (!applied) {
        db.exec(migration.sql);
        if (migration.version === 4 && db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('MIGRATION_FOREIGN_KEY_CHECK_FAILED');
        db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(
          migration.version,
          migration.name,
          checksum,
          new Date().toISOString(),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      if (migration.version === 4) db.exec('PRAGMA foreign_keys=ON');
    }
  }
}
