import { apiClient } from './client';
import type { EpmProject, ID, ProjectStatus } from '@/types';

/**
 * Portfolios — an EPM-owned grouping of projects.
 *
 * Nothing behind these endpoints copies a project. The rollups are computed
 * from the projects the caller can already see, so a portfolio never reports
 * one they cannot.
 *
 * There is no remove method. Portfolios are archived, not deleted, because
 * projects reference them.
 */

export interface EpmPortfolio {
  id: ID;
  name: string;
  code: string;
  description?: string;
  projectCount: number;
  activeProjectCount: number;
  /** Effective project health, counted by state. Not recalculated here. */
  health: { healthy: number; warning: number; critical: number };
  /** People across its projects, each counted once. */
  memberCount: number;
  capacityHours: number;
  /** Derived from those people's team mappings, never declared. */
  teams: { id: ID; name: string }[];
  /**
   * Work across its projects, summed. Progress comes from these two rather
   * than averaging each project's percentage, which would let a five-task
   * project weigh as heavily as a five-hundred-task one.
   */
  taskCount: number;
  completedTaskCount: number;
  /** Overdue work across its projects — what a project calls an open risk. */
  openRiskCount: number;
  /** Its projects' delivery status, counted rather than collapsed. */
  statuses: Record<ProjectStatus, number>;
  budgetUsed: number;
  budgetTotal: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioInput {
  name: string;
  code: string;
  description?: string;
}

export class ApiPortfolioRepository {
  list(includeInactive = false): Promise<EpmPortfolio[]> {
    return apiClient.get<EpmPortfolio[]>(
      '/portfolios',
      includeInactive ? { includeInactive: 'true' } : undefined,
    );
  }

  get(id: ID): Promise<EpmPortfolio> {
    return apiClient.get<EpmPortfolio>(`/portfolios/${id}`);
  }

  /** The projects in it, read live rather than from the association table. */
  projects(id: ID): Promise<EpmProject[]> {
    return apiClient.get<EpmProject[]>(`/portfolios/${id}/projects`);
  }

  create(input: PortfolioInput): Promise<EpmPortfolio> {
    return apiClient.post<EpmPortfolio>('/portfolios', input);
  }

  update(id: ID, input: Partial<PortfolioInput>): Promise<EpmPortfolio> {
    return apiClient.patch<EpmPortfolio>(`/portfolios/${id}`, input);
  }

  /** Deletes outright. Refused while any project is still in the portfolio. */
  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/portfolios/${id}`);
  }

  archive(id: ID): Promise<EpmPortfolio> {
    return apiClient.patch<EpmPortfolio>(`/portfolios/${id}/archive`);
  }

  restore(id: ID): Promise<EpmPortfolio> {
    return apiClient.patch<EpmPortfolio>(`/portfolios/${id}/restore`);
  }

  /**
   * Associates a project, or clears it with an empty id. Its own endpoint,
   * because the project patch is gated on the OpenProject-derived permission
   * and a portfolio is EPM's concept.
   */
  setProjectPortfolio(projectId: ID, portfolioId: string): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${projectId}/portfolio`, { portfolioId });
  }
}
