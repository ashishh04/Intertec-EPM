import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskService } from '@/services';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { CreateTaskInput, ID, TaskFilters, UpdateTaskInput } from '@/types';

export function useTasks(filters: TaskFilters = {}) {
  return useQuery({
    queryKey: queryKeys.tasks(filters),
    queryFn: () => taskService.getTasks(filters),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
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

export function useAddComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: ID; body: string }) =>
      taskService.addComment(taskId, body),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskComments(variables.taskId) });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
