import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/queryKeys';
import { scheduleService } from '@/services';
import type { ID } from '@/types';

/**
 * Critical path and float (BR-101 to BR-104).
 *
 * The figures change when a pass runs, which a change made through EPM starts
 * at once. While the server says one is pending, the figures are re-read every
 * two seconds until it has landed; otherwise they are kept for half a minute.
 */

const pendingAware = {
  staleTime: 30_000,
  refetchInterval: (query: { state: { data?: { pending?: boolean } } }) =>
    query.state.data?.pending ? 2_000 : false,
} as const;

export function useProjectCriticalPath(projectId: ID | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.criticalPath(projectId ?? ''),
    queryFn: () => scheduleService.getProjectCriticalPath(projectId!),
    enabled: Boolean(projectId) && (options.enabled ?? true),
    ...pendingAware,
  });
}

export function useWorkPackageSchedule(id: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.workPackageSchedule(id ?? ''),
    queryFn: () => scheduleService.getWorkPackageSchedule(id!),
    enabled: Boolean(id),
    ...pendingAware,
  });
}

export function useScheduleStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.scheduleStatus(),
    queryFn: () => scheduleService.getStatus(),
    enabled,
    ...pendingAware,
  });
}

export function useRecalculateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => scheduleService.recalculate(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['schedule'] }),
  });
}
