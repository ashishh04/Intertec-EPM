import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskService } from '@/services';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { CreateTaskInput, ID, TaskFilters, UpdateTaskInput } from '@/types';

export function useTasks(filters: TaskFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.tasks(filters),
    queryFn: () => taskService.getTasks(filters),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    // A picker that only has a project once the person has chosen one must not
    // ask for every task in the instance while they decide.
    enabled: options.enabled ?? true,
  });
}

export function useTask(id?: ID) {
  return useQuery({
    queryKey: queryKeys.task(id ?? 'unknown'),
    queryFn: () => taskService.getTask(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/**
 * The task's ancestors and children.
 *
 * Its own query rather than part of `useTask`: the detail page should paint
 * from the task alone, and nothing else in the product needs the tree.
 */
export function useTaskHierarchy(id?: ID) {
  return useQuery({
    queryKey: queryKeys.taskHierarchy(id ?? 'unknown'),
    queryFn: () => taskService.getHierarchy(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

function useTaskInvalidation() {
  const queryClient = useQueryClient();
  return () =>
    invalidationGroups.taskWrite.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
}

export function useCreateTask() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => taskService.createTask(input),
    onSuccess: invalidate,
  });
}

export function useUpdateTask() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => taskService.updateTask(input),
    onSuccess: invalidate,
  });
}

export function useBulkUpdateTasks() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: ID[]; patch: Partial<UpdateTaskInput> }) =>
      taskService.bulkUpdate(ids, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteTasks() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (ids: ID[]) => taskService.deleteTasks(ids),
    onSuccess: invalidate,
  });
}

