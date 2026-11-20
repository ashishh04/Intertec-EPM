/**
 * The list a task was opened from, so its page can step to the task before or
 * after it — up and down the project's task list, a sprint's column, a section
 * of My Work — without going back to the list each time.
 *
 * Kept in this tab's session: another tab opened on a list has its own, and a
 * task opened from a link elsewhere has none, and its page then shows no arrows.
 */

const KEY = 'epm.task-sequence';
/** A long list is kept whole up to here. */
const MOST = 5000;

interface Stored {
  ids: string[];
  /** The list's address, to go back to it. */
  from: string;
}

export function rememberSequence(ids: readonly string[], from: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ids: ids.slice(0, MOST), from } satisfies Stored));
  } catch {
    /* storage unavailable: the arrows simply do not show */
  }
}

/** Where a task stands in the list it was opened from; null when it was not opened from one. */
export function sequenceAround(id: string): { previous?: string; next?: string; position: number; total: number; from: string } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    const index = stored.ids.indexOf(id);
    if (index < 0 || stored.ids.length < 2) return null;
    return {
      previous: index > 0 ? stored.ids[index - 1] : undefined,
      next: index < stored.ids.length - 1 ? stored.ids[index + 1] : undefined,
      position: index + 1,
      total: stored.ids.length,
      from: stored.from,
    };
  } catch {
    return null;
  }
}

/** A link's task id when it opens a task's page: `/tasks/123`. */
export function taskIdOfLink(anchor: HTMLAnchorElement): string | undefined {
  try {
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin) return undefined;
    return /^\/tasks\/(\d+)\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}
