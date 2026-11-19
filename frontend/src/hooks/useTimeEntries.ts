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
 * so it clears the same caches a task write does alongside its own — and the
 * project's, whose spend to date and health are worked out from logged time,
 * and the timesheets', whose hours and entries are that time: without them a
 * timesheet still read "0h logged" after the hours had been logged.
 */
const TIME_WRITE = [['time-entries'], ['tasks'], ['queries'], ['dashboard'], ['reports'], ['teams'], ['projects'], ['timesheets']];

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

/**
 * How long after a time write the dashboards are read again. Utilisation, the
 * capacity heatmap and the other figures come from the analytics model, which
 * picks a change up within about thirty seconds of it; read at once they still
 * show the time from before, and the person who just logged an hour reads that
 * as "it did not count".
 */
const MODEL_CATCH_UP_MS = 40_000;

function useTimeInvalidation() {
  const client = useQueryClient();
  return () => {
    TIME_WRITE.forEach((key) => client.invalidateQueries({ queryKey: key }));
    setTimeout(() => {
      void client.invalidateQueries({ queryKey: ['insights'] });
      void client.invalidateQueries({ queryKey: ['resources'] });
    }, MODEL_CATCH_UP_MS);
  };
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

/** The reader's running timer, checked every minute and whenever the window regains focus. */
export function useRunningTimer() {
  return useQuery({
    queryKey: ['time-entries', 'timer'],
    queryFn: () => timeEntryService.timer(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Starts, stops (logging the time) and discards the timer. */
export function useTimerMutations() {
  const client = useQueryClient();
  const invalidate = useTimeInvalidation();
  const settle = () => {
    void client.invalidateQueries({ queryKey: ['time-entries', 'timer'] });
    invalidate();
  };
  return {
    start: useMutation({ mutationFn: (workPackageId: ID) => timeEntryService.startTimer(workPackageId), onSuccess: settle }),
    stop: useMutation({ mutationFn: (comment?: string) => timeEntryService.stopTimer(comment), onSuccess: settle }),
    discard: useMutation({ mutationFn: () => timeEntryService.discardTimer(), onSuccess: settle }),
  };
}
