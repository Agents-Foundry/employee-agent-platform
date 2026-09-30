import pg from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { PasswordConfig } from '../src/auth.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { DatabaseScopeError } from '../src/db/pg-store.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import {
  TENANT_DOMAIN_CHANNEL,
  TenantDomainCache,
  type DomainChangeFeed,
} from '../src/organization/tenant-domain-cache.js';
import { testStore, type TestStore } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

/** A notification feed the test drives by hand. */
class FakeFeed implements DomainChangeFeed {
  notify = () => {};
  lose = () => {};
  failures = 0;
  listens = 0;
  async listen(channel: string, onNotify: () => void, onLost: () => void) {
    expect(channel).toBe(TENANT_DOMAIN_CHANNEL);
    this.listens++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('connection refused');
    }
    this.notify = onNotify;
    this.lose = onLost;
    return () => {
      this.notify = () => {};
    };
  }
}

function counted(results: (string | null)[]) {
  const load = vi.fn(async () => results.shift() ?? null);
  return load;
}

describe('tenant domain cache', () => {
  it('remembers only while change notifications are connected', async () => {
    const feed = new FakeFeed(),
      cache = new TenantDomainCache(feed);
    const load = counted(['org-a', 'org-a', 'org-a']);
    await cache.resolve('a.example.com', load);
    await cache.resolve('a.example.com', load);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.start();
    expect(cache.live).toBe(true);
    expect(await cache.resolve('a.example.com', load)).toBe('org-a');
    expect(await cache.resolve('a.example.com', load)).toBe('org-a');
    expect(load).toHaveBeenCalledTimes(3);
    cache.stop();
    expect(cache.live).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('forgets everything on a notification, including lookups that were running', async () => {
    const feed = new FakeFeed(),
      cache = new TenantDomainCache(feed);
    await cache.start();
    const load = counted(['org-a', null]);
    await cache.resolve('a.example.com', load);
    feed.notify();
    expect(await cache.resolve('a.example.com', load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);

    // A lookup that started before a change must not be remembered after it.
    let finish!: (value: string | null) => void;
    const slow = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)));
    feed.notify();
    const before = cache.resolve('b.example.com', slow);
    feed.notify();
    const after = cache.resolve('b.example.com', counted(['org-b-new']));
    finish('org-b-old');
    expect(await before).toBe('org-b-old');
    expect(await after).toBe('org-b-new');
    expect(await cache.resolve('b.example.com', counted(['unused']))).toBe('org-b-new');
    cache.stop();
  });

  it('shares one lookup between concurrent requests and never remembers errors', async () => {
    const feed = new FakeFeed(),
      cache = new TenantDomainCache(feed);
    await cache.start();
    const load = counted(['org-a']);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => cache.resolve('a.example.com', load)),
    );
    expect(new Set(answers)).toEqual(new Set(['org-a']));
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(cache.resolve('c.example.com', failing)).rejects.toThrow('database unavailable');
    await expect(cache.resolve('c.example.com', failing)).rejects.toThrow('database unavailable');
    expect(failing).toHaveBeenCalledTimes(2);
    cache.stop();
  });

  it('expires entries, unrecognized hosts sooner, and bounds how many it keeps', async () => {
    let time = 0;
    const feed = new FakeFeed(),
      cache = new TenantDomainCache(feed, {
        ttlMs: 1000,
        negativeTtlMs: 100,
        maxEntries: 2,
        now: () => time,
      });
    await cache.start();
    const known = counted(['org-a', 'org-a']),
      unknown = counted([null, null]);
    await cache.resolve('a.example.com', known);
    await cache.resolve('x.example.com', unknown);
    time = 150;
    await cache.resolve('a.example.com', known);
    await cache.resolve('x.example.com', unknown);
    expect(known).toHaveBeenCalledTimes(1);
    expect(unknown).toHaveBeenCalledTimes(2);
    time = 1001;
    await cache.resolve('a.example.com', known);
    expect(known).toHaveBeenCalledTimes(2);

    // The least recently used host is dropped first.
    await cache.resolve('b.example.com', counted(['org-b']));
    await cache.resolve('a.example.com', known);
    await cache.resolve('c.example.com', counted(['org-c']));
    expect(cache.size).toBe(2);
    const reload = counted(['org-b']);
    await cache.resolve('b.example.com', reload);
    expect(reload).toHaveBeenCalledTimes(1);
    cache.stop();
  });

  it('goes to the database while disconnected and listens again', async () => {
    const feed = new FakeFeed(),
      cache = new TenantDomainCache(feed, { retryMs: 10 });
    feed.failures = 1;
    await cache.start();
    expect(cache.live).toBe(false);
    await vi.waitFor(() => expect(cache.live).toBe(true));
    await cache.resolve('a.example.com', counted(['org-a']));
    expect(cache.size).toBe(1);

    feed.lose();
    expect(cache.live).toBe(false);
    expect(cache.size).toBe(0);
    const load = counted(['org-a', 'org-a']);
    await cache.resolve('a.example.com', load);
    await cache.resolve('a.example.com', load);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(cache.live).toBe(true));
    expect(feed.listens).toBe(3);
    cache.stop();
  });

  it('stops retrying once the store is closed', async () => {
    const feed: DomainChangeFeed = {
      listen: vi.fn(async () => {
        throw new DatabaseScopeError('DATABASE_CLOSED');
      }),
    };
    const cache = new TenantDomainCache(feed, { retryMs: 1 });
    await cache.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(feed.listen).toHaveBeenCalledTimes(1);
  });
});

describe('tenant domain resolution across API instances', () => {
  const config: PasswordConfig = {
    mode: 'password',
    adminUrl: 'http://localhost:4200/',
    employeeUrl: 'http://localhost:4300/',
    secureCookies: false,
  };
  const host = 'agents.demo.example.com';
  let fixture: TestStore | undefined;
  const databases: ControlPlaneDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.tenancy.domains.stop();
    await fixture?.drop();
    fixture = undefined;
  });

  async function instances() {
    fixture = await testStore();
    const signer = new ManifestSigner();
    const second = await ControlPlaneDatabase.open({
      store: await fixture.connect(),
      signer,
      seedDemo: true,
    });
    databases.push(second);
    const time = new Date().toISOString();
    // Before the first instance listens, so this insert's own notification never reaches it.
    await rawSql(second)
      .prepare(
        `INSERT INTO organization_domains(id,organization_id,domain,domain_type,verification_status,verification_token,verified_at,created_at,updated_at,created_by)
         VALUES ('domain-demo','org_agents_foundry',?,'custom_domain','verified','',?,?,?,'employee_qa_demo')`,
      )
      .run(host, time, time, time);
    const first = await ControlPlaneDatabase.open({
      store: fixture.store,
      signer,
      domainCache: { retryMs: 20 },
    });
    databases.push(first);
    return { first, second };
  }

  it('reuses a resolution and sees changes committed by another instance at once', async () => {
    const { first, second } = await instances();
    expect(first.tenancy.domains.live).toBe(true);
    const get = vi.spyOn(first.store, 'get');
    const lookups = () =>
      get.mock.calls.filter(([sql]) => sql.includes('FROM organization_domains d')).length;
    expect(await first.tenancy.resolveVerifiedDomain(host)).toBe('org_agents_foundry');
    expect(await first.tenancy.resolveVerifiedDomain(`${host.toUpperCase()}.`)).toBe(
      'org_agents_foundry',
    );
    const app = createApp(first, config);
    for (let i = 0; i < 3; i++) await request(app).get('/api/health').set('Host', host).expect(200);
    expect(lookups()).toBe(1);

    const other = rawSql(second);
    await other
      .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
      .run('org_agents_foundry');
    await vi.waitFor(async () =>
      expect(await first.tenancy.resolveVerifiedDomain(host)).toBeNull(),
    );
    await request(app).get('/api/health').set('Host', host).expect(421);

    await other
      .prepare("UPDATE organizations SET status='active' WHERE id=?")
      .run('org_agents_foundry');
    await vi.waitFor(async () =>
      expect(await first.tenancy.resolveVerifiedDomain(host)).toBe('org_agents_foundry'),
    );
    await other
      .prepare("UPDATE organization_domains SET verification_status='disabled' WHERE id=?")
      .run('domain-demo');
    await vi.waitFor(async () =>
      expect(await first.tenancy.resolveVerifiedDomain(host)).toBeNull(),
    );
  });

  it('answers from the database while its listener is down, then listens again', async () => {
    const { first, second } = await instances();
    await expect(
      first.store.listen(
        'x; DROP TABLE organizations',
        () => {},
        () => {},
      ),
    ).rejects.toThrow('INVALID_CHANNEL');
    expect(await first.tenancy.resolveVerifiedDomain(host)).toBe('org_agents_foundry');
    const database = new URL(fixture!.urls.owner).pathname.slice(1);
    const admin = new pg.Client({ connectionString: inject('postgresAdminUrl') });
    await admin.connect();
    try {
      const terminated = await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND query=$2`,
        [database, `LISTEN ${TENANT_DOMAIN_CHANNEL}`],
      );
      expect(terminated.rowCount).toBe(2); // One listener per instance.
    } finally {
      await admin.end();
    }
    await vi.waitFor(() => expect(first.tenancy.domains.live).toBe(false));
    // A change made while nothing listens is still seen: lookups go to the database.
    await rawSql(second)
      .prepare("UPDATE organization_domains SET verification_status='disabled' WHERE id=?")
      .run('domain-demo');
    expect(await first.tenancy.resolveVerifiedDomain(host)).toBeNull();
    await vi.waitFor(() => expect(first.tenancy.domains.live).toBe(true));
    await rawSql(second)
      .prepare("UPDATE organization_domains SET verification_status='verified' WHERE id=?")
      .run('domain-demo');
    await vi.waitFor(async () =>
      expect(await first.tenancy.resolveVerifiedDomain(host)).toBe('org_agents_foundry'),
    );
  });
});
