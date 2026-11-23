import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

import { env } from '@/config/env';
import { invalidationGroups } from '@/lib/queryKeys';

/**
 * Keeps every screen current without a reload or a click.
 *
 * Listens to the server's live update stream (`/api/events`, backend
 * lib/live.ts), which says which areas changed — work, time, sprints,
 * projects, people… — whoever changed them: another person, another tab, the
 * rules, an import running behind. The open page then fetches again what it
 * shows from those areas, through the same reads as ever.
 *
 * Only what is on screen is fetched (React Query refetches the queries in use
 * and marks the rest stale for when they are next shown), and at most once every
 * few seconds however many changes arrive: a burst of edits is one refresh.
 */

/** What each area's change refreshes. An area named nowhere here refreshes the queries named after it. */
const AREA_KEYS: Record<string, readonly QueryKey[]> = {
  work: [
    ...invalidationGroups.taskWrite,
    ['risks'],
    ['stage-gates'],
    ['governance'],
    ['approvals'],
    ['task-timeline'],
    ['task-series'],
    ['calendar'],
    ['portal'],
  ],
  time: [
    ['time-entries'],
    ['timesheets'],
    ['tasks'],
    ['queries'],
    ['task-timeline'],
    ['dashboard'],
    ['reports'],
    ['teams'],
    ['projects'],
    ['portal'],
  ],
  sprints: [['sprints'], ['tasks'], ['queries'], ['backlog'], ['boards'], ['impediments'], ['schedule']],
  members: [['members'], ['projects'], ['current-user'], ['users'], ['teams']],
  projects: [
    ['projects'],
    ['dashboard'],
    ['activity'],
    ['reports'],
    ['portfolios'],
    ['portfolio-views'],
    ['programs'],
    ['project-settings'],
    ['members'],
    ['governance'],
    ['project-requests'],
  ],
  views: [['queries']],
  people: [['users'], ['teams'], ['employees'], ['admin'], ['members'], ['placeholder-people'], ['external']],
  // The analytics model refreshed: every figure read from it.
  insights: [['insights'], ['resources'], ['forecasts'], ['recommendations'], ['earned-value']],
  approvals: [['approvals'], ['tasks'], ['queries'], ['timesheets'], ['expenses'], ['project-requests']],
  expenses: [['expenses'], ['approvals'], ['projects']],
  notifications: [['notifications']],
  preferences: [['preferences']],
  me: [['current-user'], ['users']],
};

/** A change is gathered this long with the ones that follow it… */
const GATHER_MS = 800;
/** …and the page refreshes at most this often. */
const LEAST_GAP_MS = 3_000;

export function LiveUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const pending = new Set<string>();
    let timer: number | undefined;
    let lastRefresh = 0;
    let dropped = false;

    const refresh = () => {
      timer = undefined;
      // Not while a save of this page's is on its way: a card just moved shows
      // where it was dropped, and a fetch in between would put it back.
      if (queryClient.isMutating() > 0) {
        timer = window.setTimeout(refresh, 1_000);
        return;
      }
      lastRefresh = Date.now();
      const keys = new Map<string, QueryKey>();
      for (const area of pending) for (const key of AREA_KEYS[area] ?? [[area]]) keys.set(JSON.stringify(key), key);
      pending.clear();
      for (const key of keys.values()) void queryClient.invalidateQueries({ queryKey: key });
    };

    const hear = (areas: readonly string[]) => {
      for (const area of areas) pending.add(area);
      timer ??= window.setTimeout(refresh, Math.max(GATHER_MS, lastRefresh + LEAST_GAP_MS - Date.now()));
    };

    const source = new EventSource(`${env.apiBaseUrl}/events`, { withCredentials: true });
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const { areas } = JSON.parse(event.data) as { areas?: unknown };
        if (Array.isArray(areas)) hear(areas.filter((area): area is string => typeof area === 'string'));
      } catch {
        /* not a message of ours */
      }
    };
    // Back after a drop: what changed meanwhile went unheard, so all that is
    // shown is fetched again. The browser reconnects by itself (`retry`).
    source.onopen = () => {
      if (!dropped) return;
      dropped = false;
      void queryClient.invalidateQueries();
    };
    source.onerror = () => {
      dropped = true;
    };

    return () => {
      source.close();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [queryClient]);

  return null;
}
