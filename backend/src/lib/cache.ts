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

/** How long a load running behind a request may take, on its own signal. */
const BACKGROUND_LOAD_MS = 5 * 60_000;

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /**
   * Bumped by every write and invalidation. A load that began before one may
   * hold what it changed: for a key that was dropped, its answer goes back to
   * whoever asked but is not kept; for any other, it is kept as already expired.
   */
  private epoch = 0;
  /** Keys dropped by a write or an invalidation: the epoch a load must have begun in to be kept. */
  private readonly floor = new Map<string, number>();
  private clearedAt = 0;

  constructor(private readonly defaultTtlMs = 60_000) {}

  /**
   * Returns the cached value, or calls `load` and caches the result.
   * Concurrent callers for the same key share one upstream request rather than
   * each firing their own.
   *
   * `staleMs`, for what is only shown (names, counts, a dashboard's figures),
   * never for what decides access: for that long past its time an entry is
   * still answered at once while a fresh one loads behind it, so a page is not
   * held up every time the value expires. The load behind gets a signal of its
   * own (`load`'s argument), not the request's, which may end first.
   */
  async get<T>(
    key: string,
    load: (signal?: AbortSignal) => Promise<T>,
    ttlMs = this.defaultTtlMs,
    options: { staleMs?: number } = {},
  ): Promise<T> {
    const entry = this.entries.get(key);
    const now = Date.now();
    if (entry && entry.expiresAt > now) return entry.value as T;

    const pending = this.inFlight.get(key);
    if (entry && options.staleMs && now < entry.expiresAt + options.staleMs) {
      if (!pending) void this.load(key, () => load(AbortSignal.timeout(BACKGROUND_LOAD_MS)), ttlMs).catch(() => undefined);
      noteServedStale();
      return entry.value as T;
    }
    if (pending) return pending as Promise<T>;
    return this.load(key, () => load(), ttlMs);
  }

  private load<T>(key: string, run: () => Promise<T>, ttlMs: number): Promise<T> {
    const epoch = this.epoch;
    const promise = run()
      .then((value) => {
        this.store(key, value, epoch, ttlMs);
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  private store(key: string, value: unknown, epoch: number, ttlMs: number) {
    if (epoch < this.clearedAt || epoch < (this.floor.get(key) ?? 0)) return;
    this.floor.delete(key);
    const now = Date.now();
    this.entries.set(key, { value, expiresAt: epoch === this.epoch ? now + ttlMs : now });
  }

  private drop(key: string) {
    this.entries.delete(key);
    this.inFlight.delete(key);
    this.floor.delete(key);
    this.floor.set(key, this.epoch);
    while (this.floor.size > 4_000) {
      const oldest = this.floor.keys().next().value;
      if (oldest === undefined) break;
      this.floor.delete(oldest);
    }
  }

  /**
   * After a write by `scope` (the current caller's, unless named — `u<id>`):
   * their entries are dropped, so their next read waits for one with the
   * change; everyone else's expire now, answered once more at once where read
   * with `staleMs` and reloaded where not.
   */
  written(scope = callerScope()) {
    this.epoch += 1;
    const suffix = `:${scope}`;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (key.endsWith(suffix)) this.drop(key);
      else entry.expiresAt = Math.min(entry.expiresAt, now);
    }
    for (const key of this.inFlight.keys()) {
      if (key.endsWith(suffix)) this.drop(key);
    }
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
    this.epoch += 1;
    this.drop(key);
  }

  /**
   * Drops every entry whose key starts with `prefix`. User-scoped entries are
   * stored as `<name>:u<id>`, so invalidating `<name>` has to clear all of
   * them rather than a single key.
   */
  invalidatePrefix(prefix: string) {
    this.epoch += 1;
    const matches = (key: string) => key === prefix || key.startsWith(`${prefix}:`);
    for (const key of this.entries.keys()) {
      if (matches(key)) this.drop(key);
    }
    // The next read loads afresh rather than joining one that began before.
    for (const key of this.inFlight.keys()) {
      if (matches(key)) this.drop(key);
    }
  }

  clear() {
    this.epoch += 1;
    this.clearedAt = this.epoch;
    this.entries.clear();
    this.inFlight.clear();
    this.floor.clear();
  }
}

/**
 * The scope a cache key carries for the caller: `u<id>` for a signed-in user,
 * `automation` for the automation account, `system` for unattended work.
 */
export function callerScope(): string {
  const userId = currentAuth()?.userId;
  if (userId) return `u${userId}`;
  // The automation account sees only the projects it is a member of: its
  // reads must never land in, or be served from, the system bucket.
  return isAutomation() ? 'automation' : 'system';
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
  return `${name}:${callerScope()}`;
}

/**
 * Requests answered, wholly or partly, from a value older than its fresh
 * period. Keyed by the request's own auth object (one per request), so nothing
 * outlives the request. The response then says so (`X-EPM-Stale`, app.ts) and
 * the browser asks again a moment later, by when the fresh value has loaded.
 */
const servedStale = new WeakSet<object>();

function noteServedStale() {
  const auth = currentAuth();
  if (auth) servedStale.add(auth);
}

/** Whether this request's answer included a value older than its fresh period. */
export function wasServedStale(auth: object | undefined): boolean {
  return Boolean(auth && servedStale.has(auth));
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
 * After a write (`written`) the writer's own entries are dropped, so the read
 * their page makes straight after waits for one that has the change, while
 * everyone else's are answered at once once more and refreshed behind. A load
 * that began before a write is neither joined nor kept as fresh after it.
 * `invalidate*` and `clear` drop entries outright, for everyone.
 */
export class SwrCache {
  private readonly entries = new Map<string, { value: unknown; at: number; generation: number }>();
  private readonly inFlight = new Map<string, { promise: Promise<unknown>; generation: number }>();
  /** Counts the writes heard of: a load begun before the latest may not have it. */
  private generation = 0;
  /** Keys dropped by a write or an invalidation: the generation a load must have to be kept. */
  private readonly floor = new Map<string, number>();
  /** Since `clear`, no load begun before it is kept, whatever its key. */
  private clearedAt = 0;

  constructor(
    private readonly freshMs: number,
    private readonly staleMs: number,
    private readonly maxEntries = 400,
    private readonly loadTimeoutMs = BACKGROUND_LOAD_MS,
  ) {}

  async get<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
    if (entry && age < this.freshMs) return entry.value as T;
    if (entry && age < this.staleMs) {
      // Served as it was; the fresh one is for the next request.
      void this.refresh(key, load).catch(() => undefined);
      noteServedStale();
      return entry.value as T;
    }
    return this.refresh(key, load);
  }

  private refresh<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    // Joined only when begun since the latest write: one begun before may not have it.
    if (pending && pending.generation === this.generation) return pending.promise as Promise<T>;
    const generation = this.generation;
    const promise = load(AbortSignal.timeout(this.loadTimeoutMs)).then((value) => {
      this.store(key, value, generation);
      return value;
    });
    this.inFlight.set(key, { promise, generation });
    const release = () => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    };
    promise.then(release, release);
    return promise;
  }

  /**
   * A write was made, by the caller of the current request (or by unattended
   * work, whose scope is `system` or `automation`). Their entries are dropped;
   * everyone else's are made stale without being dropped.
   */
  written(caller = callerScope()) {
    this.generation += 1;
    const scope = `:${caller}`;
    const stale = Date.now() - this.freshMs;
    for (const [key, entry] of this.entries) {
      if (key.endsWith(scope)) {
        this.entries.delete(key);
        this.setFloor(key);
      } else {
        entry.at = Math.min(entry.at, stale);
      }
    }
    // The writer's loads still running are not kept either.
    for (const key of this.inFlight.keys()) {
      if (key.endsWith(scope)) this.setFloor(key);
    }
  }

  /**
   * Makes every entry stale without dropping it: the next request is still
   * answered at once, from it, and refreshes it behind. For changes elsewhere
   * that a list reflects but nobody is waiting to see this second.
   */
  expire() {
    this.generation += 1;
    const stale = Date.now() - this.freshMs;
    for (const entry of this.entries.values()) entry.at = Math.min(entry.at, stale);
  }

  /** Drops every entry whose key starts with `prefix` (user-scoped keys carry `:u<id>` after it). */
  invalidatePrefix(prefix: string) {
    this.generation += 1;
    const matches = (key: string) => key === prefix || key.startsWith(`${prefix}:`);
    for (const key of this.entries.keys()) {
      if (matches(key)) {
        this.entries.delete(key);
        this.setFloor(key);
      }
    }
    for (const key of this.inFlight.keys()) {
      if (matches(key)) this.setFloor(key);
    }
  }

  clear() {
    this.generation += 1;
    this.clearedAt = this.generation;
    this.entries.clear();
    this.floor.clear();
  }

  private setFloor(key: string) {
    this.floor.delete(key);
    this.floor.set(key, this.generation);
    // Bounded: the oldest floors are long past any load still running.
    while (this.floor.size > this.maxEntries * 4) {
      const oldest = this.floor.keys().next().value;
      if (oldest === undefined) break;
      this.floor.delete(oldest);
    }
  }

  private store(key: string, value: unknown, generation: number) {
    // Begun before the write or invalidation that dropped this key: not kept.
    if (generation < this.clearedAt || generation < (this.floor.get(key) ?? 0)) return;
    const current = this.entries.get(key);
    // Never over an answer begun after this one.
    if (current && current.generation > generation) return;
    this.floor.delete(key);
    this.entries.delete(key);
    // Begun before a later write elsewhere: kept, but stale, so the next read refreshes it.
    const at = generation === this.generation ? Date.now() : Date.now() - this.freshMs;
    this.entries.set(key, { value, at, generation });
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
 * served for an hour while a fresh one is built behind — the response says it
 * was stale, and the browser asks again once the fresh one is in.
 */
export const projectLists = new SwrCache(20_000, 60 * 60_000, 300);
export const sprintLists = new SwrCache(20_000, 60 * 60_000, 300);

/**
 * Lists of work, per person, language and request: the Tasks views and the
 * task lists behind My Work, Gantt and the pickers. Fresh for half a minute,
 * served for ten while refreshed; after a write to work the writer's are
 * dropped and everyone else's refreshed (routes/queries.ts).
 */
export const taskViews = new SwrCache(30_000, 10 * 60_000, 150);

/** Reference data: statuses, types, priorities. Rarely changes. */
export const referenceCache = new TtlCache(10 * 60_000);

/** Aggregates and counts. Short-lived so the UI still feels live. */
export const aggregateCache = new TtlCache(20_000);

/** How long display data past its time may still be answered while it refreshes. */
export const DISPLAY_STALE_MS = 60 * 60_000;
