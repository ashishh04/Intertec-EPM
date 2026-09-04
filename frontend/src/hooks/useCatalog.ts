import { useQuery } from '@tanstack/react-query';
import { catalogService } from '@/services';
import type { ID } from '@/types';

/**
 * Reference data hooks.
 *
 * Catalogue values change only when an administrator edits the instance, so
 * they are cached hard — every picker in the app would otherwise refetch the
 * same 14 statuses on each mount.
 */
const REFERENCE_DATA = { staleTime: 15 * 60_000, gcTime: 30 * 60_000 } as const;

export function useStatuses() {
  return useQuery({
    queryKey: ['catalog', 'statuses'],
    queryFn: () => catalogService.getStatuses(),
    ...REFERENCE_DATA,
  });
}

export function useTypes() {
  return useQuery({
    queryKey: ['catalog', 'types'],
    queryFn: () => catalogService.getTypes(),
    ...REFERENCE_DATA,
  });
}

/**
 * The options behind a schema field that publishes a link instead of a list.
 *
 * Keyed by that href and cached for the session: the same collection backs
 * several fields, and it is reference data rather than anything that moves.
 */
export function useAllowedValues(href?: string) {
  return useQuery({
    queryKey: ['catalog', 'allowed-values', href ?? ''],
    queryFn: () => catalogService.getAllowedValues(href!),
    enabled: Boolean(href),
    ...REFERENCE_DATA,
  });
}

export function usePriorities() {
  return useQuery({
    queryKey: ['catalog', 'priorities'],
    queryFn: () => catalogService.getPriorities(),
    ...REFERENCE_DATA,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['catalog', 'roles'],
    queryFn: () => catalogService.getRoles(),
    ...REFERENCE_DATA,
  });
}

export function useProjectTypes(projectId?: ID) {
  return useQuery({
    queryKey: ['catalog', 'project-types', projectId],
    queryFn: () => catalogService.getProjectTypes(projectId!),
    enabled: Boolean(projectId),
    ...REFERENCE_DATA,
  });
}

export function useProjectVersions(projectId?: ID) {
  return useQuery({
    queryKey: ['catalog', 'project-versions', projectId],
    queryFn: () => catalogService.getProjectVersions(projectId!),
    enabled: Boolean(projectId),
    ...REFERENCE_DATA,
  });
}

export function useProjectCategories(projectId?: ID) {
  return useQuery({
    queryKey: ['catalog', 'project-categories', projectId],
    queryFn: () => catalogService.getProjectCategories(projectId!),
    enabled: Boolean(projectId),
    ...REFERENCE_DATA,
  });
}

export function useProjectAssignees(projectId?: ID) {
  return useQuery({
    queryKey: ['catalog', 'project-assignees', projectId],
    queryFn: () => catalogService.getProjectAssignees(projectId!),
    enabled: Boolean(projectId),
    ...REFERENCE_DATA,
  });
}
