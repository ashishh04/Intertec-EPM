import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { relationService, watcherService } from '@/services';
import type { ID } from '@/types';

/**
 * Watchers and relations on a work package.
 *
 * Kept off the task queries: both change independently of the work package
 * itself, and neither should force a task refetch to stay current.
 */

export const watcherKeys = {
  state: (workPackageId: ID) => ['watchers', workPackageId] as const,
  available: (workPackageId: ID) => ['watchers', workPackageId, 'available'] as const,
};

export const relationKeys = {
  list: (workPackageId: ID) => ['relations', workPackageId] as const,
  types: () => ['relations', 'types'] as const,
  relatable: (workPackageId: ID, term: string) =>
    ['relations', workPackageId, 'relatable', term] as const,
};

export function useWatchers(workPackageId?: ID) {
  return useQuery({
    queryKey: watcherKeys.state(workPackageId ?? 'unknown'),
    queryFn: () => watcherService.get(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

/** Only fetched while the picker is open — the list is useless until then. */
export function useAvailableWatchers(workPackageId: ID, enabled: boolean) {
  return useQuery({
    queryKey: watcherKeys.available(workPackageId),
    queryFn: () => watcherService.available(workPackageId),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Adding and removing both invalidate the candidate list as well as the
 * watchers, because upstream moves people between the two.
 */
function useWatcherMutation(workPackageId: ID) {
  const client = useQueryClient();

  return () => {
    void client.invalidateQueries({ queryKey: watcherKeys.state(workPackageId) });
    void client.invalidateQueries({ queryKey: watcherKeys.available(workPackageId) });
  };
}

export function useAddWatcher(workPackageId: ID) {
  const settle = useWatcherMutation(workPackageId);

  return useMutation({
    mutationFn: (userId: ID) => watcherService.add(workPackageId, userId),
    onSuccess: settle,
  });
}

export function useRemoveWatcher(workPackageId: ID) {
  const settle = useWatcherMutation(workPackageId);

  return useMutation({
    mutationFn: (userId: ID) => watcherService.remove(workPackageId, userId),
    onSuccess: settle,
  });
}

export function useRelations(workPackageId?: ID) {
  return useQuery({
    queryKey: relationKeys.list(workPackageId ?? 'unknown'),
    queryFn: () => relationService.list(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

/** The vocabulary is instance configuration, so it is cached for the session. */
export function useRelationTypes(enabled = true) {
  return useQuery({
    queryKey: relationKeys.types(),
    queryFn: () => relationService.types(),
    enabled,
    staleTime: Infinity,
  });
}

export function useRelatable(workPackageId: ID, term: string, enabled: boolean) {
  return useQuery({
    queryKey: relationKeys.relatable(workPackageId, term),
    queryFn: () => relationService.relatable(workPackageId, term || undefined),
    enabled,
    staleTime: 10_000,
  });
}

/**
 * Invalidates both ends.
 *
 * A relation belongs to two work packages, and the other one's list is now
 * stale too — without this, opening it would show a relation that no longer
 * exists, or miss one that does.
 */
function useRelationMutation(workPackageId: ID) {
  const client = useQueryClient();

  return (relatedId?: ID) => {
    void client.invalidateQueries({ queryKey: relationKeys.list(workPackageId) });
    if (relatedId) void client.invalidateQueries({ queryKey: relationKeys.list(relatedId) });
  };
}

export function useCreateRelation(workPackageId: ID) {
  const settle = useRelationMutation(workPackageId);

  return useMutation({
    mutationFn: (input: { type: string; relatedId: ID }) =>
      relationService.create(workPackageId, input),
    onSuccess: (relation) => settle(relation.related.id),
  });
}

export function useDeleteRelation(workPackageId: ID) {
  const settle = useRelationMutation(workPackageId);

  return useMutation({
    mutationFn: (relation: { id: ID; related: { id: ID } }) => relationService.remove(relation.id),
    onSuccess: (_result, relation) => settle(relation.related.id),
  });
}
