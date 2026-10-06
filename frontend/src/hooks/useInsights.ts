import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { insightsService } from '@/services';
import type { InsightQuery } from '@/services/api/insights';
import { queryKeys } from '@/lib/queryKeys';
import type { DashboardId } from '@/types';

/**
 * The semantic layer and the dashboards (BR-404, BR-405). The model behind
 * them refreshes on its own within a minute of a change, so figures are
 * re-read every minute while a page is open.
 */

const LIVE = { staleTime: 30_000, refetchInterval: 60_000 } as const;

export function useMeasureCatalogue() {
  return useQuery({ queryKey: queryKeys.measures(), queryFn: () => insightsService.getMeasures(), staleTime: 10 * 60_000 });
}

export function useMeasureValues(ids: string[], query: InsightQuery = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.measureValues(ids, query),
    queryFn: () => insightsService.getValues(ids, query),
    enabled: enabled && ids.length > 0,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

/** The items behind a measure; fetched only when somebody opens them. */
export function useMeasureMembers(id: string | undefined, query: InsightQuery = {}) {
  return useQuery({
    queryKey: queryKeys.measureMembers(id ?? '', query),
    queryFn: () => insightsService.getMembers(id!, query),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useMeasureTrend(id: string, query: InsightQuery & { bucket?: 'week' | 'month' } = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.measureTrend(id, query),
    queryFn: () => insightsService.getTrend(id, query),
    enabled,
    ...LIVE,
  });
}

export function useDashboards() {
  return useQuery({ queryKey: queryKeys.dashboards(), queryFn: () => insightsService.getDashboards(), staleTime: 60 * 60_000 });
}

export function useDashboard(id: DashboardId, query: InsightQuery = {}) {
  return useQuery({
    queryKey: queryKeys.dashboard(id, query),
    queryFn: () => insightsService.getDashboard(id, query),
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function useStateAsAt(at: string | undefined, scope?: string) {
  return useQuery({
    queryKey: queryKeys.stateAsAt(at ?? '', scope),
    queryFn: () => insightsService.getStateAsAt(at!, scope),
    enabled: Boolean(at),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------- the model (admin) */

export function useAnalyticsModel(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.analyticsModel(),
    queryFn: () => insightsService.getModelStatus(),
    enabled,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useRefreshRuns(enabled: boolean, page: number, pageSize: number, kind?: 'full' | 'incremental') {
  return useQuery({
    queryKey: queryKeys.analyticsRuns(page, pageSize, kind),
    queryFn: () => insightsService.getRefreshRuns({ page, pageSize, kind }),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useRefreshModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (kind: 'full' | 'incremental') => insightsService.refresh(kind),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['analytics-model'] });
      void client.invalidateQueries({ queryKey: ['insights'] });
    },
  });
}

export function useCaptures(enabled: boolean, page: number, pageSize: number) {
  return useQuery({
    queryKey: queryKeys.analyticsCaptures(page, pageSize),
    queryFn: () => insightsService.getCaptures({ page, pageSize }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCapture() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => insightsService.capture(),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['analytics-model', 'captures'] }),
  });
}

/** A comparison reads the whole capture; run on demand. */
export function useCompareCapture() {
  return useMutation({ mutationFn: (captureId: string) => insightsService.compare(captureId) });
}

export function useAnalyticsAccess(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.analyticsAccess(),
    queryFn: () => insightsService.getAccess(),
    enabled,
    staleTime: 60_000,
  });
}
