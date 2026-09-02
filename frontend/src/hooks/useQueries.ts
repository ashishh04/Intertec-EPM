import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryService } from '@/services';
import type { ID } from '@/types';
import type { QueryOverrides } from '@/services/api/queries';

/**
 * Hooks for OpenProject-backed views.
 *
 * Query results are cached per (view, overrides) so paging and sorting reuse
 * what has already been fetched, and `placeholderData` keeps the previous page
 * on screen while the next one loads rather than flashing an empty table.
 *
 * Nothing here is cached across users: every request carries the caller's
 * session, and the cache is cleared on sign-out.
 */

/** Filter metadata is instance configuration; it changes about as often as statuses. */
const SCHEMA_CACHE = { staleTime: 15 * 60_000, gcTime: 30 * 60_000 } as const;

export const queryKeys = {
  schema: (projectId?: ID) => ['queries', 'schema', projectId ?? 'global'] as const,
  list: (projectId?: ID) => ['queries', 'list', projectId ?? 'global'] as const,
  run: (id: ID | 'default', overrides: QueryOverrides) =>
    ['queries', 'run', id, overrides] as const,
};

/** Available filters, with their operators and value shapes. */
export function useQuerySchema(projectId?: ID) {
  return useQuery({
    queryKey: queryKeys.schema(projectId),
    queryFn: () => queryService.getSchema(projectId),
    ...SCHEMA_CACHE,
  });
}

/** Saved views the caller can see. */
export function useSavedQueries(projectId?: ID) {
  return useQuery({
    queryKey: queryKeys.list(projectId),
    queryFn: () => queryService.getQueries(projectId),
    staleTime: 60_000,
  });
}

/**
 * Runs a view and returns its page of work packages.
 *
 * `queryId` selects a saved view; omitting it uses the default. Either way the
 * overrides are applied upstream, so this never fetches more than one page.
 */
export function useQueryResult(
  queryId: ID | undefined,
  overrides: QueryOverrides,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.run(queryId ?? 'default', overrides),
    queryFn: () =>
      queryId ? queryService.run(queryId, overrides) : queryService.runDefault(overrides),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    // Keeps the current page visible while the next loads.
    placeholderData: (previous) => previous,
  });
}

function useInvalidateQueries() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['queries'] });
}

export function useCreateQuery() {
  const invalidate = useInvalidateQueries();
  return useMutation({
    mutationFn: (input: { name: string; projectId?: ID; payload?: Record<string, unknown> }) =>
      queryService.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateQuery() {
  const invalidate = useInvalidateQueries();
  return useMutation({
    mutationFn: ({ id, patch }: { id: ID; patch: Record<string, unknown> }) =>
      queryService.update(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteQuery() {
  const invalidate = useInvalidateQueries();
  return useMutation({
    mutationFn: (id: ID) => queryService.remove(id),
    onSuccess: invalidate,
  });
}

export function useToggleStar() {
  const invalidate = useInvalidateQueries();
  return useMutation({
    mutationFn: ({ id, starred }: { id: ID; starred: boolean }) =>
      starred ? queryService.unstar(id) : queryService.star(id),
    onSuccess: invalidate,
  });
}
