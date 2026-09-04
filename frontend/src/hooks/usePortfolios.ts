import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { portfolioService } from '@/services';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { PortfolioInput } from '@/services/api/portfolios';
import type { ID } from '@/types';

/**
 * Portfolios.
 *
 * Rollups are computed from live project data, so anything that changes a
 * project's health, its members' teams or its capacity also changes a
 * portfolio's numbers. Writes therefore invalidate the whole set rather than a
 * single entry.
 */

export const portfolioKeys = {
  all: ['portfolios'] as const,
  list: (includeInactive: boolean) => ['portfolios', { includeInactive }] as const,
  detail: (id: ID) => ['portfolios', 'detail', id] as const,
  projects: (id: ID) => ['portfolios', 'projects', id] as const,
};

export function usePortfolios(includeInactive = false) {
  return useQuery({
    queryKey: portfolioKeys.list(includeInactive),
    queryFn: () => portfolioService.list(includeInactive),
    staleTime: 60_000,
  });
}

export function usePortfolio(id?: ID) {
  return useQuery({
    queryKey: portfolioKeys.detail(id ?? 'unknown'),
    queryFn: () => portfolioService.get(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function usePortfolioProjects(id?: ID) {
  return useQuery({
    queryKey: portfolioKeys.projects(id ?? 'unknown'),
    queryFn: () => portfolioService.projects(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

function usePortfolioInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: portfolioKeys.all });
}

export function useCreatePortfolio() {
  const settle = usePortfolioInvalidation();

  return useMutation({
    mutationFn: (input: PortfolioInput) => portfolioService.create(input),
    onSuccess: () => void settle(),
  });
}

export function useUpdatePortfolio() {
  const settle = usePortfolioInvalidation();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<PortfolioInput> }) =>
      portfolioService.update(id, input),
    onSuccess: () => void settle(),
  });
}

/** Deactivate or reactivate. There is no delete — see the repository. */
/** Deletes a portfolio. The backend refuses while projects are still in it. */
export function useDeletePortfolio() {
  const settle = usePortfolioInvalidation();

  return useMutation({
    mutationFn: (id: ID) => portfolioService.remove(id),
    onSuccess: () => void settle(),
  });
}

export function useSetPortfolioActive() {
  const settle = usePortfolioInvalidation();

  return useMutation({
    mutationFn: ({ id, active }: { id: ID; active: boolean }) =>
      active ? portfolioService.restore(id) : portfolioService.archive(id),
    onSuccess: () => void settle(),
  });
}

/**
 * Associates a project with a portfolio.
 *
 * Reaches further than the portfolio list: the project itself carries the
 * portfolio name, and the grid, dashboard and reports all read projects.
 */
export function useSetProjectPortfolio() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, portfolioId }: { projectId: ID; portfolioId: string }) =>
      portfolioService.setProjectPortfolio(projectId, portfolioId),
    onSuccess: (_project, { projectId }) => {
      void client.invalidateQueries({ queryKey: portfolioKeys.all });
      void client.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}
