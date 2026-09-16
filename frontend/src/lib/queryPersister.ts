import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import type { Query } from '@tanstack/react-query';

/**
 * Persisted query cache.
 *
 * Without it every visit starts cold: the dashboard fires fourteen requests at
 * an empty cache and shows skeletons for seconds. With it the last known data
 * paints immediately and is revalidated behind the scenes, so the wait is only
 * ever visible the very first time someone opens the app.
 *
 * This does mean project and colleague data sits in the browser at rest. Three
 * things keep that bounded: the session itself is never persisted, the cache is
 * dropped whenever the signed-in user changes or signs out, and anything older
 * than a day is discarded rather than shown.
 */

const STORAGE_KEY = 'epm.query-cache';
/** Marker for whose data the persisted cache belongs to. */
const OWNER_KEY = 'epm.query-cache.owner';

/**
 * Bumping this discards every persisted cache. It is tied to the build so a
 * deploy that changes a response shape cannot hydrate the old one into new
 * components.
 */
const CACHE_VERSION = 'v1';

/** A day. Older data is thrown away rather than shown and corrected. */
export const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;

/**
 * Queries that must never be written to disk.
 *
 * `auth/session` and `current-user` decide whether someone is signed in and
 * what they may see. Restoring either from storage would let a stale answer
 * gate the UI — briefly showing administration to someone who has since lost
 * it, or a signed-out person the shell. Both are cheap to fetch, so they are
 * always asked for fresh.
 */
const NEVER_PERSIST = [['auth', 'session'], ['current-user']];

function isExcluded(query: Query): boolean {
  return NEVER_PERSIST.some((prefix) =>
    prefix.every((segment, index) => query.queryKey[index] === segment),
  );
}

export const queryPersister = createSyncStoragePersister({
  storage: window.localStorage,
  key: STORAGE_KEY,
  // Writing on every cache mutation would serialise the whole cache dozens of
  // times during a page load; once a second is enough to survive a reload.
  throttleTime: 1_000,
});

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister: queryPersister,
  maxAge: PERSIST_MAX_AGE,
  buster: CACHE_VERSION,
  dehydrateOptions: {
    // Only settled, successful results are worth restoring — persisting an
    // error would show it again on next load without anything having failed.
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' && !isExcluded(query),
  },
};

/** Forgets the persisted cache. Called on sign-out and on a change of user. */
export function clearPersistedCache() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/**
 * Ties the persisted cache to one person.
 *
 * Two people using the same browser must not see each other's work. The cache
 * is cleared on sign-out, but that cannot be relied on alone — a session can
 * end by expiry, or the tab can be closed mid-session. So the owner is recorded
 * alongside the cache and checked once the signed-in user is known.
 *
 * Returns true when the cache belonged to someone else and was discarded.
 */
export function reconcilePersistedCacheOwner(userId: string): boolean {
  try {
    const previous = window.localStorage.getItem(OWNER_KEY);
    if (previous === userId) return false;

    if (previous !== null) {
      clearPersistedCache();
      window.localStorage.setItem(OWNER_KEY, userId);
      return true;
    }

    window.localStorage.setItem(OWNER_KEY, userId);
    return false;
  } catch {
    return false;
  }
}
