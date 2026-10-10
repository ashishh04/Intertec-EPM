import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import { taskSeriesService } from '@/services';
import type { ID, RecurrenceRule, TaskSeriesInput } from '@/types';

/**
 * Recurring tasks (BR-105 to BR-107).
 *
 * Everything sits under ['task-series'], so one invalidation after a change
 * refreshes the template's card, the project's list and the link on each task
 * it made. Making a series, changing it or resuming it can make tasks, and
 * those are work packages: the task lists refresh as after any task write.
 */

export function useWorkPackageSeries(workPackageId: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.workPackageSeries(workPackageId ?? ''),
    queryFn: () => taskSeriesService.forWorkPackage(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

export function useProjectSeries(projectId: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.projectTaskSeries(projectId ?? ''),
    queryFn: () => taskSeriesService.listForProject(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

export function useTaskSeries(id: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.taskSeries(id ?? ''),
    queryFn: () => taskSeriesService.get(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** The next dates of a rule as it is being written; the last answer stays while the next is asked. */
export function useRecurrencePreview(rule: RecurrenceRule | undefined) {
  return useQuery({
    queryKey: queryKeys.recurrencePreview(rule ?? {}),
    queryFn: () => taskSeriesService.preview(rule!),
    enabled: Boolean(rule),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['task-series'] });
    for (const key of invalidationGroups.taskWrite) void client.invalidateQueries({ queryKey: key });
  };
}

export function useCreateSeries(workPackageId: ID) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: TaskSeriesInput) => taskSeriesService.create(workPackageId, input),
    onSuccess: refresh,
  });
}

export function useUpdateSeries(id: ID) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: TaskSeriesInput) => taskSeriesService.update(id, input),
    onSuccess: refresh,
  });
}

export function useMoveSeries(id: ID) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (move: 'pause' | 'resume' | 'cancel') => taskSeriesService.move(id, move),
    onSuccess: refresh,
  });
}

export function useGenerateSeries(id: ID) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => taskSeriesService.generate(id),
    onSuccess: refresh,
  });
}
