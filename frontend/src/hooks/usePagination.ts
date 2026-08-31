import { useCallback, useEffect, useMemo, useState } from 'react';

interface UsePaginationOptions {
  pageSize?: number;
  /**
   * Change this whenever the underlying query changes (filters, search, tab) so
   * the view returns to the first page instead of stranding the user on a page
   * that no longer exists.
   */
  resetKey?: unknown;
}

export interface PaginationState<T> {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** The slice to render. */
  items: T[];
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
}

/**
 * Client-side pagination for collections the service layer returns in full
 * (projects, teams, documents, notifications).
 *
 * Server-driven lists — work packages — page through `TaskFilters` instead, so
 * large datasets are never pulled into the browser just to be sliced here.
 */
export function usePagination<T>(
  items: T[],
  { pageSize: initialPageSize = 10, resetKey }: UsePaginationOptions = {},
): PaginationState<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Clamp rather than reset, so a collection shrinking underneath the user
  // (a task completed, a notification cleared) lands on the last real page.
  const current = Math.min(page, totalPages);

  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  );

  const setPageSize = useCallback((next: number) => {
    setPageSizeState(next);
    setPage(1);
  }, []);

  return {
    page: current,
    pageSize,
    total,
    totalPages,
    items: pageItems,
    setPage,
    setPageSize,
  };
}
