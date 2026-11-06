import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import type { Query, QueryClient } from '@tanstack/react-query';

import { intlLocale } from './i18n';

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
 *
 * It also holds words. A response's labels, reasons and messages are written
 * for the reader who asked: in the language, calendar and digits of the
 * request's `Accept-Language`, which is `intlLocale()`. A cached one keeps them
 * after that reader has moved on, which is how someone back in English was shown
 * "No change مقارنة بالأسبوع الماضي". So a save to disk records whose it is
 * (`busterFor`), and memory is emptied when the reader changes (`forgetResponses`).
 */

const STORAGE_KEY = 'epm.query-cache';
/** Marker for whose data the persisted cache belongs to. */
const OWNER_KEY = 'epm.query-cache.owner';

/**
 * A change discards every persisted cache. It is the build's identity, so a
 * deploy that changes a response shape cannot hydrate the old one into new
 * components — which a fixed version string did not prevent: the executive
 * view's figures gained their definitions in a release, and a browser holding
 * yesterday's response rendered it into the new tiles and failed.
 */
const CACHE_VERSION = __EPM_BUILD_ID__;

/** A persisted cache is restored only for this build and the reader it was written for. */
const busterFor = (reader: string) => `${CACHE_VERSION}:${reader}`;

/** A day. Older data is thrown away rather than shown and corrected. */
export const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;

/**
 * Queries that must never be written to disk.
 *
 * `auth/session` and `current-user` decide whether someone is signed in and
 * what they may see. Restoring either from storage would let a stale answer
 * gate the UI — briefly showing administration to someone who has since lost
 * it, or a signed-out person the shell. Both are cheap to fetch, so they are
 * always asked for fresh. Two-factor state too: a list of who has no second
 * factor has no business resting in a browser, and a person's own decides what
 * their next change will ask of them.
 *
 * Preferences have their own copy for the first paint (`epm.preferences`). A
 * second one here could be older than it and still young enough to be believed
 * without asking: a reload just after choosing a language restored the old one,
 * and the page went back to the language just left until a reload half a minute
 * later.
 */
const NEVER_PERSIST = [['auth', 'session'], ['current-user'], ['auth', 'mfa'], ['admin', 'mfa'], ['preferences']];

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
  // Stamped as it is written rather than from the options, which are read once:
  // the reader can change while the page is open, and a second tab, still in
  // the old language, writes to this same key.
  serialize: (client) => JSON.stringify({ ...client, buster: busterFor(intlLocale()) }),
});

/** `reader`: who this browser is about to show the restored cache to. */
export const persistOptionsFor = (reader: string): Omit<PersistQueryClientOptions, 'queryClient'> => ({
  persister: queryPersister,
  maxAge: PERSIST_MAX_AGE,
  buster: busterFor(reader),
  dehydrateOptions: {
    // Only settled, successful results are worth restoring — persisting an
    // error would show it again on next load without anything having failed.
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' && !isExcluded(query),
  },
});

/**
 * Forgets every response written for the reader who has just left, so the
 * screens ask again as they remount. In-flight requests go with them: what they
 * bring back is in the old language too. The queries that are never persisted
 * stay, as `AuthProvider` and `PreferenceEffects` above the remount are reading
 * them and they carry no words.
 */
export function forgetResponses(client: QueryClient) {
  client.removeQueries({ predicate: (query) => !isExcluded(query) });
}

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
