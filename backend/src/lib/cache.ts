import { currentAuth } from '../auth/context.js';

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
  return userId ? `${name}:u${userId}` : `${name}:system`;
}

/** Reference data: statuses, types, priorities. Rarely changes. */
export const referenceCache = new TtlCache(10 * 60_000);

/** Aggregates and counts. Short-lived so the UI still feels live. */
export const aggregateCache = new TtlCache(20_000);
