import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { organizationStructureSql } from './001-organization-structure.js';
import { jobArchitectureSql } from './002-job-architecture.js';
import { profilesIdentitiesSql } from './003-profiles-identities.js';

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
  ];
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = db
        .prepare('SELECT checksum FROM schema_migrations WHERE version=?')
        .get(migration.version);
      if (applied && applied['checksum'] !== checksum)
        throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      if (!applied) {
        db.exec(migration.sql);
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
    }
  }
}
