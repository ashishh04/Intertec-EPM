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

/** The most a timeline draws: five pages of the largest the API serves. */
export const TIMELINE_LIMIT = 1_000;
const TIMELINE_PAGE = 200;

/**
 * A project's work for its timeline, read across pages.
 *
 * A timeline is read as a whole, and its critical path view has to see all of
 * a schedule to highlight it (BR-102), so one page is not enough. Pages after
 * the first are read together. Stops at `TIMELINE_LIMIT`; `total` says when
 * there is more than was drawn.
 */
export function useTaskTimeline(projectId?: ID) {
  return useQuery({
    queryKey: queryKeys.taskTimeline(projectId ?? ''),
    queryFn: async () => {
      const filters: TaskFilters = { projectId, pageSize: TIMELINE_PAGE, sortBy: 'dueDate', sortDir: 'asc' };
      const first = await taskService.getTasks({ ...filters, page: 1 });
      const pages = Math.min(Math.ceil(first.total / TIMELINE_PAGE), TIMELINE_LIMIT / TIMELINE_PAGE);
      const rest = await Promise.all(
        Array.from({ length: Math.max(0, pages - 1) }, (_, index) => taskService.getTasks({ ...filters, page: index + 2 })),
      );
      // A task edited between two page reads can appear on both.
      const seen = new Set<ID>();
      const items = [first, ...rest]
        .flatMap((page) => page.items)
        .filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
      return { items, total: first.total };
    },
    enabled: Boolean(projectId),
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

