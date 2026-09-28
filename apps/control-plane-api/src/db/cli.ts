/**
 * Operator CLI for the control-plane database (ADR 0018).
 *
 *   bootstrap              create the roles and database named by the three connection URLs
 *                          (needs DATABASE_ADMIN_URL, a superuser)
 *   migrate                apply pending migrations as the schema owner
 *   import-sqlite <file>   copy an existing SQLite control-plane database into an empty one
 *
 * Connection URLs: DATABASE_MIGRATION_URL (schema owner), DATABASE_URL (tenant role),
 * DATABASE_PLATFORM_URL (platform role). Passwords are never printed.
 */
import { bootstrapDatabase, type LoginRole } from './bootstrap.js';
import { importSqlite } from './import-sqlite.js';
import { migrate } from './migrate.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function role(url: URL): LoginRole {
  if (!url.username || !url.password) throw new Error('DATABASE_URL_CREDENTIALS_REQUIRED');
  return { name: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === 'bootstrap') {
    const owner = new URL(required('DATABASE_MIGRATION_URL'));
    const tenant = new URL(required('DATABASE_URL'));
    const platform = new URL(required('DATABASE_PLATFORM_URL'));
    const database = owner.pathname.slice(1);
    if (
      !database ||
      tenant.pathname.slice(1) !== database ||
      platform.pathname.slice(1) !== database ||
      new Set([owner.username, tenant.username, platform.username]).size !== 3
    )
      throw new Error('DATABASE_URLS_INCONSISTENT');
    await bootstrapDatabase(required('DATABASE_ADMIN_URL'), {
      database,
      owner: role(owner),
      tenant: role(tenant),
      platform: role(platform),
    });
    console.log(`Database ${database} and its roles are ready.`);
    return;
  }
  if (command === 'migrate') {
    const applied = await migrate(required('DATABASE_MIGRATION_URL'));
    console.log(applied.length ? `Applied migrations ${applied.join(', ')}.` : 'Up to date.');
    return;
  }
  if (command === 'import-sqlite') {
    if (!argument) throw new Error('Usage: import-sqlite <sqlite-database-path>');
    const result = await importSqlite(argument, required('DATABASE_MIGRATION_URL'));
    const total = Object.values(result.tables).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ imported: total, tables: result.tables }, null, 2));
    return;
  }
  throw new Error('Usage: db <bootstrap|migrate|import-sqlite <file>>');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
