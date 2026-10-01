import { useQuery } from '@tanstack/react-query';
import { catalogService, formService } from '@/services';
import { allowedValuesOf, schemaField, type AllowedValue } from '@/services/api/forms';
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

/**
 * What one work package may actually be changed to, asked of the work package.
 *
 * OpenProject decides a status change by workflow — the type, the caller's
 * role and the status it is in now — so the instance-wide status list is a
 * superset of the legal moves. A picker built from it looked like it worked
 * and then did nothing: every refused transition came back 422 and the row
 * reverted. The work package's own edit form carries the permitted set, and is
 * the only thing that knows it.
 *
 * Not cached like the rest of this module: the answer changes the moment the
 * status does.
 */
export function useWorkPackageOptions(workPackageId?: ID) {
  return useQuery({
    queryKey: ['catalog', 'work-package-options', workPackageId],
    queryFn: () => formService.workPackageEditForm(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
    select: (form): { statuses?: AllowedValue[]; priorities?: AllowedValue[]; types?: AllowedValue[] } => {
      const options = (name: string) => {
        const field = schemaField(form, name);
        return field ? allowedValuesOf(field) : undefined;
      };
      return {
        statuses: options('status'),
        priorities: options('priority'),
        types: options('type'),
      };
    },
  });
}
