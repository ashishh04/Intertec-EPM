import { currentAuth, isAutomation } from '../auth/context.js';

/**
 * Small in-process TTL cache.
 *
 * OpenProject's HAL API is chatty and its reference data — statuses, types,
 * priorities, principals — changes rarely but is needed on almost every
 * request. Caching it is the difference between one upstream call per page and
 * a dozen.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly defaultTtlMs = 60_000) {}

  /**
   * Returns the cached value, or calls `load` and caches the result.
   * Concurrent callers for the same key share one upstream request rather than
   * each firing their own.
   */
  async get<T>(key: string, load: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value as T;

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * The cached value, or undefined — never a fetch.
   *
   * For the case where the caller can do something useful without the value and
   * only wants it if it is already there. `get` cannot serve that: it would fetch
   * and, if the loader is slow, make the caller wait for exactly the thing they
   * said they could do without.
   */
  peek<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > Date.now() ? (entry.value as T) : undefined;
  }

  /** Stores a value computed elsewhere, e.g. by a background warm-up. */
  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string) {
    this.entries.delete(key);
  }

  /**
   * Drops every entry whose key starts with `prefix`. User-scoped entries are
   * stored as `<name>:u<id>`, so invalidating `<name>` has to clear all of
   * them rather than a single key.
   */
  invalidatePrefix(prefix: string) {
    for (const key of this.entries.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Scopes a cache key to the signed-in user.
 *
 * Every OpenProject call travels on the caller's OAuth token, so responses are
 * already filtered by that user's permissions. Caching them under a bare name
 * would serve whichever user populated the entry first to everyone else until
 * it expired — either leaking records a user should not see, or hiding records
 * they should. The key carries the user id so those views stay separate.
 *
 * Unauthenticated (scheduled, unattended) work uses the configured API key and
 * gets its own `system` bucket for the same reason.
 */
export function userScopedKey(name: string): string {
  const userId = currentAuth()?.userId;
  if (userId) return `${name}:u${userId}`;
  // The automation account sees only the projects it is a member of: its
  // reads must never land in, or be served from, the system bucket.
  return isAutomation() ? `${name}:automation` : `${name}:system`;
}

/**
 * Stale-while-revalidate: a value younger than `freshMs` is served as it is;
 * one older, up to `staleMs`, is served at once while a fresh one loads behind
 * it; anything older, or nothing, is loaded and waited for. Concurrent callers
 * share one load.
 *
 * The load gets its own signal, never the caller's request: a browser that
 * gives up (its 20-second timeout on a thousand-task tree) used to cancel the
 * reads with it, so nothing was kept and every retry started from nothing. Now
 * the work finishes and the next request is served from it.
 *
 * `invalidate*` drops entries outright, so the request after a write waits for
 * fresh data rather than being shown what was there before it.
 */
export class SwrCache {
  private readonly entries = new Map<string, { value: unknown; at: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly freshMs: number,
    private readonly staleMs: number,
    private readonly maxEntries = 400,
    private readonly loadTimeoutMs = 5 * 60_000,
  ) {}

  async get<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
    if (entry && age < this.freshMs) return entry.value as T;
    const refresh = (): Promise<T> => {
      const pending = this.inFlight.get(key);
      if (pending) return pending as Promise<T>;
      const promise = load(AbortSignal.timeout(this.loadTimeoutMs))
        .then((value) => {
          this.store(key, value);
          return value;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, promise);
      return promise;
    };
    if (entry && age < this.staleMs) {
      // Served as it was; the fresh one is for the next request.
      void refresh().catch(() => undefined);
      return entry.value as T;
    }
    return refresh();
  }

  /**
   * Makes every entry stale without dropping it: the next request is still
   * answered at once, from it, and refreshes it behind. For changes elsewhere
   * that a list reflects but nobody is waiting to see this second.
   */
  expire() {
    const stale = Date.now() - this.freshMs;
    for (const entry of this.entries.values()) entry.at = Math.min(entry.at, stale);
  }

  /** Drops every entry whose key starts with `prefix` (user-scoped keys carry `:u<id>` after it). */
  invalidatePrefix(prefix: string) {
    for (const key of this.entries.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  private store(key: string, value: unknown) {
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    // The oldest go first once there are too many: insertion order is age order.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * The project list and the sprint list, per person: read on nearly every page
 * and slow to build against a busy OpenProject. Fresh for 20 seconds, then
 * served for ten minutes while a fresh one is built behind.
 */
export const projectLists = new SwrCache(20_000, 10 * 60_000, 300);
export const sprintLists = new SwrCache(20_000, 10 * 60_000, 300);

/**
 * Lists of work, per person, language and request: the Tasks views and the
 * task lists behind My Work, Gantt and the pickers. Fresh for half a minute,
 * served for ten while refreshed; dropped on any write to work (routes/queries.ts).
 */
export const taskViews = new SwrCache(30_000, 10 * 60_000, 150);

/** Reference data: statuses, types, priorities. Rarely changes. */
export const referenceCache = new TtlCache(10 * 60_000);

/** Aggregates and counts. Short-lived so the UI still feels live. */
export const aggregateCache = new TtlCache(20_000);
