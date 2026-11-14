import { lazy, type ComponentType } from 'react';

/**
 * Every routed page is its own chunk, so the first paint carries only the shell.
 * `page()` is `lazy()` with two additions that make that split invisible:
 *
 * - The loader is remembered, so once someone is signed in and the browser is
 *   idle every page can be fetched ahead of time (`prefetchPages`). A click then
 *   never waits on a download; it only renders.
 * - A failed load right after a deploy reloads the app once. An open tab still
 *   runs the previous build and asks for files the new build replaced; without
 *   this, the next page it opens fails as "This page could not be displayed".
 */
const loaders: Array<() => Promise<unknown>> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function page<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  loaders.push(load);
  return lazy(() => load().catch((error: unknown) => recoverFromStaleBuild(error)));
}

const RELOADED_AT = 'epm.reloadedForNewBuild';

/**
 * Reloads the page to pick up a newly deployed build, at most once in half a
 * minute, so a chunk that is genuinely missing cannot set off a reload loop.
 * Answers whether it reloaded.
 */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // Without storage there is no way to tell a second failure from the first.
    return false;
  }
  window.location.reload();
  return true;
}

function recoverFromStaleBuild(error: unknown): Promise<never> {
  // Reloading: show the route's fallback until the new build arrives.
  if (reloadOnce()) return new Promise<never>(() => undefined);
  throw error;
}

let prefetching = false;

/**
 * Fetches every page's chunk in the background, one at a time and only while the
 * browser is idle, so it never competes with what the person is doing. Skipped
 * where the connection asks to save data. Safe to call more than once.
 */
export function prefetchPages(): void {
  if (prefetching) return;
  prefetching = true;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || /2g$/.test(connection?.effectiveType ?? '')) return;

  const queue = [...loaders];
  const whenIdle = (callback: () => void) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(callback, { timeout: 2_000 });
    else window.setTimeout(callback, 150);
  };
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    load()
      .catch(() => undefined)
      .finally(() => whenIdle(next));
  };
  whenIdle(next);
}
