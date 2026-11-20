import { useEffect } from 'react';

import { rememberSequence, taskIdOfLink } from '@/lib/task-sequence';

/**
 * Remembers the list a task is opened from, for the arrows on its page.
 *
 * One listener for every list rather than a prop through each of them: a click
 * on a link to a task's page, inside a list — a table's rows, a column of
 * cards, a section of My Work — keeps that list's tasks in the order they are
 * shown. A list marks itself with `data-task-list` where the nearest table body
 * or list element is not the whole of it.
 */
export function TaskSequenceTracker() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !taskIdOfLink(anchor)) return;
      // A task page's own links (its parent, its relations) are not a list it was opened from.
      if (anchor.closest('[data-task-sequence="ignore"]')) return;
      const container = anchor.closest('[data-task-list], tbody, ul, ol');
      if (!container) return;
      const ids: string[] = [];
      for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const id = taskIdOfLink(link);
        if (id && !ids.includes(id)) ids.push(id);
      }
      if (ids.length > 1) rememberSequence(ids, `${window.location.pathname}${window.location.search}`);
    };
    // Captured, so it runs before the link navigates.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  return null;
}
