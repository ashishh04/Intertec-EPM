import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskService } from '@/services';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { CreateTaskInput, EpmTask, ID, TaskFilters, UpdateTaskInput } from '@/types';

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

type TaskList = { items: EpmTask[] };

export function useUpdateTask() {
  const queryClient = useQueryClient();
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => taskService.updateTask(input),
    /*
     * A move to another column shows at once. The card used to stay where it
     * was until the save and the board's reload had both come back — over three
     * seconds on a busy instance — so a drop looked as if it had not taken.
     * Only the column is known before the server answers; its task replaces
     * this guess when the lists reload, and a refusal puts the card back.
     */
    onMutate: async (input) => {
      const category = input.status;
      if (!category) return undefined;
      await queryClient.cancelQueries({ queryKey: ['tasks'] });
      const previous = queryClient
        .getQueriesData<TaskList>({ queryKey: ['tasks'] })
        .filter(([, data]) => Array.isArray(data?.items) && data.items.some((task) => task.id === input.id));
      for (const [key, data] of previous) {
        queryClient.setQueryData<TaskList>(key, {
          ...data!,
          items: data!.items.map((task) => (task.id === input.id ? { ...task, statusCategory: category } : task)),
        });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: invalidate,
  });
}

export function useBulkUpdateTasks() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: ID[]; patch: Partial<UpdateTaskInput> }) =>
      taskService.bulkUpdate(ids, patch),
    // Settled, not succeeded: the tasks are changed one at a time and a refusal
    // stops the rest, so the ones before it have changed either way.
    onSettled: invalidate,
  });
}

export function useDeleteTasks() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (ids: ID[]) => taskService.deleteTasks(ids),
    onSuccess: invalidate,
  });
}

