import { DatabaseScopeError } from './pg-store.js';

/** A source of change notifications; `PgStore.listen` is the production one. */
export interface ChangeFeed {
  listen(channel: string, onNotify: () => void, onLost: () => void): Promise<() => void>;
}

export interface ChangeListenerHandlers {
  /**
   * Runs for each notification, and once each time listening (re)starts, because anything
   * could have changed while nothing was listening.
   */
  onChange: () => void;
  /** Runs when the connection is lost; listening restarts after `retryMs`. */
  onLost?: () => void;
}

/**
 * Keeps one channel subscription alive: it retries every `retryMs` after a failure and stops
 * for good once the store is closed. Never throws.
 */
export class ChangeListener {
  private unlisten: (() => void) | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly feed: ChangeFeed,
    private readonly channel: string,
    private readonly handlers: ChangeListenerHandlers,
    private readonly retryMs = 5_000,
  ) {}

  /** Whether notifications are currently being received. */
  get live(): boolean {
    return this.unlisten !== undefined;
  }

  async start(): Promise<void> {
    if (this.stopped || this.unlisten) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    let ready = false,
      lostEarly = false;
    try {
      const unlisten = await this.feed.listen(
        this.channel,
        () => this.handlers.onChange(),
        () => (ready ? this.lost() : (lostEarly = true)),
      );
      if (this.stopped) return unlisten();
      if (lostEarly) return this.scheduleRetry();
      this.unlisten = unlisten;
      ready = true;
      this.handlers.onChange();
    } catch (error) {
      if (error instanceof DatabaseScopeError) return; // The store is closed.
      this.scheduleRetry();
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.unlisten?.();
    this.unlisten = undefined;
  }

  private lost(): void {
    this.unlisten = undefined;
    this.handlers.onLost?.();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.start();
    }, this.retryMs);
    this.retry.unref();
  }
}
