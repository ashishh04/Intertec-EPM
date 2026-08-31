import { useQuery } from '@tanstack/react-query';
import { dashboardService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

export function useDashboardMetrics() {
  return useQuery({
    queryKey: queryKeys.dashboardMetrics,
    queryFn: () => dashboardService.getMetrics(),
    staleTime: 30_000,
  });
}

export function useActivity(params: { projectId?: ID; limit?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.activity(params),
    queryFn: () => dashboardService.getActivity(params),
    staleTime: 30_000,
  });
}

export function useCalendarEvents(range: { from: string; to: string }) {
  return useQuery({
    queryKey: queryKeys.calendarEvents(range),
    queryFn: () => dashboardService.getCalendarEvents(range),
    staleTime: 60_000,
  });
}
