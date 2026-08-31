import { useQuery } from '@tanstack/react-query';
import { reportService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ReportFilters } from '@/types';

export function useDeliveryTrends(filters?: ReportFilters) {
  return useQuery({
    queryKey: queryKeys.deliveryTrends(filters),
    queryFn: () => reportService.getDeliveryTrends(filters),
    staleTime: 120_000,
  });
}

export function useStatusDistribution(filters?: ReportFilters) {
  return useQuery({
    queryKey: queryKeys.statusDistribution(filters),
    queryFn: () => reportService.getStatusDistribution(filters),
    staleTime: 120_000,
  });
}

export function useExecutiveInsights(filters?: ReportFilters) {
  return useQuery({
    queryKey: queryKeys.executiveInsights(filters),
    queryFn: () => reportService.getExecutiveInsights(filters),
    staleTime: 120_000,
  });
}

export function useTimeSummary(filters?: ReportFilters) {
  return useQuery({
    queryKey: queryKeys.timeSummary(filters),
    queryFn: () => reportService.getTimeSummary(filters),
    staleTime: 120_000,
  });
}
