/**
 * Vitest global setup (ADR 0018): a PostgreSQL server for the suite and a migrated template
 * database that every test clones.
 *
 * Uses TEST_DATABASE_ADMIN_URL (a superuser URL) when set, as in CI. Otherwise starts a
 * throwaway `postgres:16` container on a free local port and removes it afterwards.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapDatabase, dropDatabase, roleUrl } from '../../src/db/bootstrap.js';
import { migrate } from '../../src/db/migrate.js';
import { TEST_ROLES, TEMPLATE_DATABASE } from './postgres-roles.js';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresAdminUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('PORT')),
      );
    });
  });
}

async function ready(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
  let container: string | undefined;
  if (!adminUrl) {
    const port = await freePort();
    const password = randomBytes(12).toString('hex');
    container = `af-control-plane-test-${process.pid}`;
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        container,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-p',
        `127.0.0.1:${port}:5432`,
        '--tmpfs',
        '/var/lib/postgresql/data',
        'postgres:16',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
        '-c',
        'max_connections=400',
      ],
      { stdio: 'ignore', timeout: 120_000 },
    );
    adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  }
  try {
    await ready(adminUrl);
    await dropDatabase(adminUrl, TEMPLATE_DATABASE);
    await bootstrapDatabase(adminUrl, { database: TEMPLATE_DATABASE, ...TEST_ROLES });
    await migrate(roleUrl(adminUrl, TEMPLATE_DATABASE, TEST_ROLES.owner));
  } catch (error) {
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    throw error;
  }
  project.provide('postgresAdminUrl', adminUrl);
  return async () => {
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    else await dropDatabase(adminUrl, TEMPLATE_DATABASE);
  };
}
