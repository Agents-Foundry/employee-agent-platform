import { ChangeListener, type ChangeFeed } from '../db/change-listener.js';

/** The channel migration 0007 notifies whenever a tenant domain resolution could change. */
export const TENANT_DOMAIN_CHANNEL = 'af_tenant_domains';

export type DomainChangeFeed = ChangeFeed;

export interface TenantDomainCacheOptions {
  /** How long a verified host's organization is reused (default 60 s). */
  ttlMs?: number;
  /** How long an unrecognized host is remembered (default 30 s). */
  negativeTtlMs?: number;
  /** At most this many hosts are remembered; the least recently used are dropped first. */
  maxEntries?: number;
  /** Delay before listening again after the connection is lost (default 5 s). */
  retryMs?: number;
  now?: () => number;
}

interface Entry {
  organizationId: string | null;
  expiresAt: number;
}

/**
 * Which organization each verified host belongs to, remembered per API instance (ADR 0027).
 *
 * Every change that could alter a resolution notifies all instances when it commits, and each
 * instance then forgets everything. Entries are used only while that notification feed is
 * connected: without it every lookup goes to the database, so a missed change can never be
 * served from memory. Expiry bounds how long a change could go unseen if notifications
 * stopped arriving without the connection failing. Lookup errors are never remembered.
 */
export class TenantDomainCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly listener: ChangeListener;
  private generation = 0;

  constructor(feed: DomainChangeFeed, options: TenantDomainCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
    // Anything remembered while not listening could have missed a change.
    this.listener = new ChangeListener(
      feed,
      TENANT_DOMAIN_CHANNEL,
      { onChange: () => this.invalidate(), onLost: () => this.invalidate() },
      options.retryMs,
    );
  }

  /** Whether entries are being used: only while change notifications are connected. */
  get live(): boolean {
    return this.listener.live;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Starts listening for changes. Never throws; failures retry in the background. */
  start(): Promise<void> {
    return this.listener.start();
  }

  stop(): void {
    this.listener.stop();
    this.invalidate();
  }

  /** Forgets every resolution, including lookups still running. */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }

  /** The organization for a normalized host, from memory or from `load`. */
  resolve(host: string, load: () => Promise<string | null>): Promise<string | null> {
    if (!this.live) return load();
    const entry = this.entries.get(host);
    if (entry) {
      this.entries.delete(host);
      if (entry.expiresAt > this.now()) {
        this.entries.set(host, entry);
        return Promise.resolve(entry.organizationId);
      }
    }
    const running = this.pending.get(host);
    if (running) return running;
    const generation = this.generation;
    const lookup = load()
      .then((organizationId) => {
        // A change notified while the lookup ran may not be reflected in its answer.
        if (generation === this.generation && this.live) this.remember(host, organizationId);
        return organizationId;
      })
      .finally(() => {
        if (this.pending.get(host) === lookup) this.pending.delete(host);
      });
    this.pending.set(host, lookup);
    return lookup;
  }

  private remember(host: string, organizationId: string | null): void {
    const ttl = organizationId === null ? this.negativeTtlMs : this.ttlMs;
    this.entries.set(host, { organizationId, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
  }
}
