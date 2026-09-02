import type { Paginated } from '../types/epm.js';

/**
 * The frontend's `Paginated<T>` envelope.
 *
 * Only `/tasks` is paginated in the contract; every other collection returns a
 * bare array. OpenProject pages are 1-based (`offset` is a page number), which
 * matches the frontend's `page`, so no translation is needed beyond clamping.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_RESPONSE_PAGE_SIZE = 200;

export interface PageRequest {
  page: number;
  pageSize: number;
}

export function resolvePage(page?: number, pageSize?: number): PageRequest {
  const safePage = Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : 1;
  const requested =
    Number.isFinite(pageSize) && (pageSize as number) > 0
      ? Math.floor(pageSize as number)
      : DEFAULT_PAGE_SIZE;

  return { page: safePage, pageSize: Math.min(requested, MAX_RESPONSE_PAGE_SIZE) };
}

export function paginated<T>(items: T[], total: number, request: PageRequest): Paginated<T> {
  return {
    items,
    total,
    page: request.page,
    pageSize: request.pageSize,
    hasMore: request.page * request.pageSize < total,
  };
}

