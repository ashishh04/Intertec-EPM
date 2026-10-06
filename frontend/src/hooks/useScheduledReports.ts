import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { scheduledReportService } from '@/services';
import type { ReportRunFilter } from '@/services/api/scheduled-reports';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, ReportScheduleInput } from '@/types';

/**
 * Scheduled reports (BRQ-08). Everything here is behind `reports:schedule`;
 * callers pass whether they hold it. A run's emails go out in the background,
 * so the log is re-read while the page is open.
 */

const ROOT = ['report-schedules'] as const;

export function useReportSchedules(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.reportSchedules(),
    queryFn: () => scheduledReportService.getSchedules(),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useReportScheduleOptions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.reportScheduleOptions(),
    queryFn: () => scheduledReportService.getOptions(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveReportSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: ReportScheduleInput }) =>
      id ? scheduledReportService.update(id, input) : scheduledReportService.create(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ROOT }),
  });
}

export function useDeleteReportSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => scheduledReportService.remove(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ROOT }),
  });
}

export function useApproveReportSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => scheduledReportService.approve(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ROOT }),
  });
}

export function useRunReportSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => scheduledReportService.run(id),
    onSettled: () => void client.invalidateQueries({ queryKey: ROOT }),
  });
}

export function useReportRuns(enabled: boolean, filter: ReportRunFilter) {
  return useQuery({
    queryKey: queryKeys.reportRuns(filter),
    queryFn: () => scheduledReportService.getRuns(filter),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
}

/** One run with every copy and how its email went; re-read while emails are still going out. */
export function useReportRun(id: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.reportRun(id ?? ''),
    queryFn: () => scheduledReportService.getRun(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.deliveryState === 'pending' || query.state.data?.status === 'running' ? 5_000 : false),
  });
}
