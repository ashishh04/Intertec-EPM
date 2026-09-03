import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { analyticsService } from '@/services';
import type { TrendQuery } from '@/services/api/analytics';

/**
 * Analytics.
 *
 * Trends read only the snapshot table, so they are cheap and can be cached
 * longer than anything computed from OpenProject. A capture changes what every
 * trend returns, so it invalidates all of them.
 */

export const analyticsKeys = {
  all: ['analytics'] as const,
  overview: ['analytics', 'overview'] as const,
  trends: (query: TrendQuery) => ['analytics', 'trends', query] as const,
};

export function useAnalyticsOverview() {
  return useQuery({
    queryKey: analyticsKeys.overview,
    queryFn: () => analyticsService.overview(),
    staleTime: 60_000,
  });
}

export function useTrends(query: TrendQuery, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.trends(query),
    queryFn: () => analyticsService.trends(query),
    enabled,
    // Snapshots change once a day at most, so this need not be refetched often.
    staleTime: 5 * 60_000,
  });
}

export function useCaptureSnapshot() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => analyticsService.captureSnapshot(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: analyticsKeys.all });
    },
  });
}
