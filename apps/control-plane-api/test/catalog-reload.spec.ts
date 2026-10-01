import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_BUNDLE_SCHEMA,
  bundleDigest,
  type BlueprintBundleContent,
} from '../src/catalog/catalog-registry.js';
import { CATALOG_VERSION_CHANNEL, CatalogService } from '../src/catalog/catalog-service.js';
import type { ChangeFeed } from '../src/db/change-listener.js';
import { ControlPlaneDatabase } from '../src/database.js';
import type { PgStore } from '../src/db/pg-store.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { RawSql } from './support/raw-sql.js';
import { testStore, type TestStore } from './support/database.js';

const qa = builtInCatalog.blueprints[0]!;

/** A notification feed that connects but never notifies, or never connects. */
const silentFeed = (connects = true): ChangeFeed => ({
  listen: async () => {
    if (!connects) throw new Error('connection refused');
    return () => {};
  },
});

/**
 * Registers a QA version the way another release's instance would: a copy of a shipped
 * version under a new number, stored with its digest and the current bundle schema unless
 * `stored` overrides them.
 */
async function register(
  store: PgStore,
  version: string,
  change: (content: BlueprintBundleContent) => void = () => {},
  stored: { digest?: string; schema?: string } = {},
): Promise<void> {
  const raw = new RawSql(store);
  const row = await raw
    .prepare('SELECT content FROM catalog_blueprint_versions WHERE blueprint_id=? AND version=?')
    .get<{ content: string }>(qa.id, qa.version);
  const content = JSON.parse(row!.content) as BlueprintBundleContent;
  content.blueprint.version = version;
  content.blueprint.mission = `Mission ${version}.`;
  change(content);
  await raw
    .prepare(
      'INSERT INTO catalog_blueprint_versions (blueprint_id,version,digest,bundle_schema,content,registered_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      qa.id,
      version,
      stored.digest ?? bundleDigest(content),
      stored.schema ?? CATALOG_BUNDLE_SCHEMA,
      JSON.stringify(content),
      new Date().toISOString(),
    );
}

const versions = async (catalog: CatalogService) =>
  (await catalog.summaries()).filter((s) => s.id === qa.id).map((s) => [s.version, s.latest]);

describe('catalog versions registered by another instance', () => {
  let fixture: TestStore | undefined;
  const stops: (() => void)[] = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    await fixture?.drop();
    fixture = undefined;
  });

  async function open(options: Parameters<typeof CatalogService.open>[2] = {}) {
    fixture ??= await testStore();
    const catalog = await CatalogService.open(fixture.store, builtInCatalog, options);
    stops.push(() => catalog.stop());
    await catalog.start();
    return catalog;
  }

  it('loads a version when its registration is notified, without a restart', async () => {
    fixture = await testStore();
    const signer = new ManifestSigner();
    const first = await ControlPlaneDatabase.open({ store: fixture.store, signer });
    stops.push(() => first.catalog.stop());
    expect(first.catalog.live).toBe(true);
    await first.catalog.reload(); // Let the load started by listening finish first.
    const get = vi.spyOn(first.store, 'get');
    const all = vi.spyOn(first.store, 'all');
    await register(await fixture.connect(), '1.3.0');
    // Listings are served from memory while listening, so only the notification can add it.
    await vi.waitFor(async () =>
      expect(await versions(first.catalog)).toContainEqual(['1.3.0', true]),
    );
    expect(
      all.mock.calls.filter(([sql]) => sql.includes('catalog_blueprint_versions')),
    ).toHaveLength(1);
    expect((await first.catalog.bundle(qa.id, '1.3.0')).blueprint.mission).toBe('Mission 1.3.0.');
    expect(get.mock.calls.some(([sql]) => sql.includes('catalog_blueprint_versions'))).toBe(false);
    expect((await first.catalog.legacyBlueprints()).find((b) => b.id === qa.id)?.version).toBe(
      '1.3.0',
    );
  });

  it('notifies only when a statement registers a version', async () => {
    fixture = await testStore();
    (await CatalogService.open(fixture.store, builtInCatalog)).stop();
    let notifications = 0;
    const unlisten = await fixture.store.listen(
      CATALOG_VERSION_CHANNEL,
      () => notifications++,
      () => {},
    );
    stops.push(unlisten);
    // Starting again with every shipped version registered inserts nothing.
    (await CatalogService.open(await fixture.connect(), builtInCatalog)).stop();
    await register(fixture.store, '1.3.0');
    await vi.waitFor(() => expect(notifications).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notifications).toBe(1);
  });

  it('resolves a version from the database before its notification arrives', async () => {
    const catalog = await open({ feed: silentFeed() });
    expect(catalog.live).toBe(true);
    await register(fixture!.store, '1.3.0');
    expect(await versions(catalog)).not.toContainEqual(['1.3.0', true]);
    expect((await catalog.bundle(qa.id, '1.3.0')).blueprint.mission).toBe('Mission 1.3.0.');
    // Once read, it is known: listed, and resolved from memory.
    expect(await versions(catalog)).toContainEqual(['1.3.0', true]);
    await expect(catalog.bundle(qa.id, '9.9.9', 404)).rejects.toMatchObject({
      status: 404,
      message: 'BLUEPRINT_VERSION_UNKNOWN',
    });
  });

  it('reloads listings while notifications are not received', async () => {
    const catalog = await open({ feed: silentFeed(false), retryMs: 60_000 });
    expect(catalog.live).toBe(false);
    await register(fixture!.store, '1.3.0');
    expect(await versions(catalog)).toContainEqual(['1.3.0', true]);
  });

  it('reloads listings again after a failed reload', async () => {
    let notify = () => {};
    const catalog = await open({
      feed: {
        listen: async (_channel, onNotify) => {
          notify = onNotify;
          return () => {};
        },
      },
    });
    await register(fixture!.store, '1.3.0');
    const all = vi.spyOn(fixture!.store, 'all').mockRejectedValueOnce(new Error('connection lost'));
    notify();
    await vi.waitFor(() => expect(all).toHaveBeenCalledTimes(1));
    expect(await versions(catalog)).toContainEqual(['1.3.0', true]);
    expect(all).toHaveBeenCalledTimes(2);
    // Loaded now, so listings come from memory again.
    await versions(catalog);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('never serves a stored version it cannot verify', async () => {
    const catalog = await open({ feed: silentFeed() });
    const store = fixture!.store;
    // Content that no longer matches its digest.
    await register(store, '1.3.0', () => {}, { digest: '0'.repeat(64) });
    // A version declaring an action this release's policy engine does not know.
    await register(store, '1.4.0', (content) =>
      content.blueprint.policy.actions.push('reactor.melt'),
    );
    // Content that is not the version it is stored as.
    await register(store, '1.5.0', (content) => (content.blueprint.version = '1.1.0'));
    for (const version of ['1.3.0', '1.4.0', '1.5.0'])
      await expect(catalog.bundle(qa.id, version, 404)).rejects.toMatchObject({
        status: 409,
        message: 'BLUEPRINT_VERSION_UNSUPPORTED',
      });
    await catalog.reload();
    expect(await versions(catalog)).toEqual([
      ['1.2.0', true],
      ['1.1.0', false],
    ]);
  });

  it('refuses bundles this release cannot interpret, even with a matching digest', async () => {
    const catalog = await open({ feed: silentFeed() });
    const store = fixture!.store;
    const refused: [string, (content: BlueprintBundleContent) => void, string?][] = [
      // Written in a bundle structure a newer release introduced.
      ['2.0.0', () => {}, 'agents-foundry.catalog-bundle/v2'],
      // A field the current schemas do not know is refused, not ignored.
      ['2.1.0', (content) => Object.assign(content.blueprint, { sandboxEscape: true })],
      ['2.2.0', (content) => Object.assign(content.tools[0]!, { scopes: ['*'] })],
      // A field of the wrong shape.
      ['2.3.0', (content) => Object.assign(content.blueprint, { mission: 42 })],
      // Not exactly the pinned definitions.
      ['2.4.0', (content) => content.tools.pop()],
      ['2.5.0', (content) => content.skills.push(structuredClone(content.skills[0]!))],
      // Internally inconsistent: a workflow step uses an action the blueprint does not grant.
      ['2.6.0', (content) => (content.workflows[0]!.steps[0]!.action = 'workspace.command')],
    ];
    for (const [version, change, schema] of refused)
      await register(store, version, change, schema ? { schema } : {});
    const outcomes = await Promise.all(
      refused.map(([version]) =>
        catalog.bundle(qa.id, version, 404).then(
          () => [version, 'served'],
          (error: { status?: number; message: string }) => [version, error.status, error.message],
        ),
      ),
    );
    expect(outcomes).toEqual(
      refused.map(([version]) => [version, 409, 'BLUEPRINT_VERSION_UNSUPPORTED']),
    );
    await catalog.reload();
    expect((await versions(catalog)).map(([version]) => version)).toEqual(['1.2.0', '1.1.0']);
    // The same content under the current schema is served.
    await register(store, '2.7.0');
    expect((await catalog.bundle(qa.id, '2.7.0')).blueprint.version).toBe('2.7.0');
  });
});
