import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { timeEntryService } from '@/services';
import type {
  CreateTimeEntryInput,
  ID,
  TimeEntryFilters,
  TimeReportFilters,
  UpdateTimeEntryInput,
} from '@/types';

/**
 * Logged time.
 *
 * A write changes a work package's spent hours and every rollup built on them,
 * so it clears the same caches a task write does alongside its own.
 */
const TIME_WRITE = [['time-entries'], ['tasks'], ['queries'], ['dashboard'], ['reports'], ['teams']];

export function useTimeEntries(filters: TimeEntryFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.timeEntries(filters),
    queryFn: () => timeEntryService.list(filters),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    enabled: options.enabled ?? true,
  });
}

/**
 * The people the Time & Costs person filter may offer.
 *
 * Reference data — it changes when somebody joins a project — so it is cached
 * for as long as the other reference lists.
 */
export function useReportablePeople() {
  return useQuery({
    queryKey: ['time-entries', 'people'] as const,
    queryFn: () => timeEntryService.people(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Hours and cost over a range.
 *
 * Kept a little staler than the list — a cost report is read, not watched, and
 * the range behind it is usually in the past — but still under the same
 * `time-entries` root, so logging an hour refreshes it.
 */
export function useTimeReport(filters: TimeReportFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.timeReport(filters),
    queryFn: () => timeEntryService.report(filters),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    enabled: options.enabled ?? true,
  });
}

function useTimeInvalidation() {
  const client = useQueryClient();
  return () => TIME_WRITE.forEach((key) => client.invalidateQueries({ queryKey: key }));
}

export function useLogTime() {
  const invalidate = useTimeInvalidation();
  return useMutation({
    mutationFn: (input: CreateTimeEntryInput) => timeEntryService.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateTimeEntry() {
  const invalidate = useTimeInvalidation();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTimeEntryInput & { id: ID }) =>
      timeEntryService.update(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteTimeEntry() {
  const invalidate = useTimeInvalidation();
  return useMutation({
    mutationFn: (id: ID) => timeEntryService.remove(id),
    onSuccess: invalidate,
  });
}
