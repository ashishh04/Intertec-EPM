import { apiClient } from './client';
import type {
  CostEntries,
  ID,
  PortfolioOverview,
  PortfolioView,
  PortfolioViewInput,
  PortfolioViewOptions,
} from '@/types';

/**
 * Portfolios in one view, and saved views of them (BRQ-06: BR-201 to BR-203).
 * Open to anyone signed in and built for them: projects they cannot see are
 * left out and counted, never an error.
 */

export interface OverviewQuery {
  from?: string;
  to?: string;
}

const period = (query: OverviewQuery = {}) => ({
  ...(query.from ? { from: query.from } : {}),
  ...(query.to ? { to: query.to } : {}),
});

export class ApiPortfolioViewRepository {
  getPortfolioOverview(portfolioId: ID, query?: OverviewQuery): Promise<PortfolioOverview> {
    return apiClient.get<PortfolioOverview>(`/portfolios/${portfolioId}/overview`, period(query));
  }

  getViews(): Promise<PortfolioView[]> {
    return apiClient.get<PortfolioView[]>('/portfolio-views');
  }

  getOptions(): Promise<PortfolioViewOptions> {
    return apiClient.get<PortfolioViewOptions>('/portfolio-views/options');
  }

  getView(id: ID): Promise<PortfolioView> {
    return apiClient.get<PortfolioView>(`/portfolio-views/${id}`);
  }

  /** Over the view's own period unless one is given. */
  getViewOverview(id: ID, query?: OverviewQuery): Promise<PortfolioOverview> {
    return apiClient.get<PortfolioOverview>(`/portfolio-views/${id}/overview`, period(query));
  }

  create(input: PortfolioViewInput): Promise<PortfolioView> {
    return apiClient.post<PortfolioView>('/portfolio-views', input);
  }

  update(id: ID, input: PortfolioViewInput): Promise<PortfolioView> {
    return apiClient.patch<PortfolioView>(`/portfolio-views/${id}`, input);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/portfolio-views/${id}`);
  }

  /** The priced time entries behind a cost figure, for one project (BR-202). */
  getCostEntries(measureId: string, projectId: ID | number, query: OverviewQuery & { page: number; pageSize: number }): Promise<CostEntries> {
    return apiClient.get<CostEntries>(`/measures/${encodeURIComponent(measureId)}/entries`, {
      scope: `project:${projectId}`,
      ...period(query),
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
