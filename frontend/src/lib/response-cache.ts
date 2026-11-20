import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * What the app keeps of the server's answers: in this tab's memory, while it is
 * open, and nowhere else. Nothing is written to the browser's storage, where a
 * person's projects, tasks and colleagues would stay on the machine after they
 * had signed out or walked away — the app used to keep a day of answers there
 * and restore them on the next visit.
 */

/** Where earlier builds kept their copy of the answers, and whose it was. */
const STORED_KEYS = ['epm.query-cache', 'epm.query-cache.owner'];

/** Removes what an earlier build left in this browser's storage. */
export function purgeStoredResponses(): void {
  try {
    for (const key of STORED_KEYS) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing was kept there either */
  }
}

/**
 * Queries whose answers carry no words: whether someone is signed in and what
 * they may see, two-factor state, preferences. Kept when the language changes;
 * `AuthProvider` and `PreferenceEffects`, above the screens that remount, read them.
 */
const WORDLESS = [['auth', 'session'], ['current-user'], ['auth', 'mfa'], ['admin', 'mfa'], ['preferences']];

function isWordless(query: Query): boolean {
  return WORDLESS.some((prefix) => prefix.every((segment, index) => query.queryKey[index] === segment));
}

/**
 * Forgets every answer written for the reader who has just left — a response's
 * labels and messages are in the language it was asked in — so the screens ask
 * again as they remount. In-flight requests go with them: what they bring back
 * is in the old language too.
 */
export function forgetResponses(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => !isWordless(query) });
}
