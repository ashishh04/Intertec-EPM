import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { portfolioViewService } from '@/services';
import type { OverviewQuery } from '@/services/api/portfolio-views';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, PortfolioViewInput } from '@/types';

/**
 * Portfolios in one view and saved views of them (BR-201 to BR-203). The
 * figures come from the analytics model, which follows a change within a
 * minute, so they are re-read every minute while a page is open.
 */

const LIVE = { staleTime: 30_000, refetchInterval: 60_000 } as const;

export function usePortfolioOverview(portfolioId: ID | undefined, query: OverviewQuery = {}) {
  return useQuery({
    queryKey: queryKeys.portfolioOverview(portfolioId ?? '', query),
    queryFn: () => portfolioViewService.getPortfolioOverview(portfolioId!, query),
    enabled: Boolean(portfolioId),
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function usePortfolioViews() {
  return useQuery({ queryKey: queryKeys.portfolioViews(), queryFn: () => portfolioViewService.getViews() });
}

export function usePortfolioViewOptions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioViewOptions(),
    queryFn: () => portfolioViewService.getOptions(),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function usePortfolioView(id: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.portfolioView(id ?? ''),
    queryFn: () => portfolioViewService.getView(id!),
    enabled: Boolean(id),
  });
}

export function usePortfolioViewOverview(id: ID | undefined, query: OverviewQuery = {}) {
  return useQuery({
    queryKey: queryKeys.portfolioViewOverview(id ?? '', query),
    queryFn: () => portfolioViewService.getViewOverview(id!, query),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function useSavePortfolioView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: PortfolioViewInput }) =>
      id ? portfolioViewService.update(id, input) : portfolioViewService.create(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['portfolio-views'] });
      void client.invalidateQueries({ queryKey: ['insights', 'portfolio-view-overview'] });
    },
  });
}

export function useDeletePortfolioView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => portfolioViewService.remove(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['portfolio-views'] }),
  });
}

/** The time entries behind a cost figure for one project; fetched when someone opens them. */
export function useCostEntries(
  measureId: string | undefined,
  projectId: ID | number | undefined,
  query: OverviewQuery & { page: number; pageSize: number },
) {
  return useQuery({
    queryKey: queryKeys.costEntries(measureId ?? '', String(projectId ?? ''), query),
    queryFn: () => portfolioViewService.getCostEntries(measureId!, projectId!, query),
    enabled: Boolean(measureId && projectId !== undefined),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
