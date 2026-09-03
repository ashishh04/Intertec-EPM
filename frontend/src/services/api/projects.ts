import { apiClient } from './client';
import type { ProjectRepository } from '../repositories';
import type { ID, Milestone, EpmProject, HealthOverride } from '@/types';

/**
 * Projects arrive from the EPM backend already normalized. The backend owns
 * the OpenProject call, its HAL parsing and its pagination.
 */
export class ApiProjectRepository implements ProjectRepository {
  getProjects(params: { search?: string; status?: string[] } = {}): Promise<EpmProject[]> {
    return apiClient.get<EpmProject[]>('/projects', {
      search: params.search,
      status: params.status,
    });
  }

  getProject(id: ID): Promise<EpmProject> {
    return apiClient.get<EpmProject>(`/projects/${id}`);
  }

  getMilestones(projectId: ID): Promise<Milestone[]> {
    return apiClient.get<Milestone[]>(`/projects/${projectId}/milestones`);
  }

  updateProject(id: ID, patch: Partial<EpmProject>): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${id}`, patch);
  }

  /**
   * Pins health dimensions. Its own endpoint, not part of the project patch:
   * that one is gated on the OpenProject-derived project:edit, and health
   * authority is EPM's.
   *
   * The body is the whole override — an omitted dimension is cleared, so `{}`
   * clears every pin.
   */
  setHealthOverride(id: ID, override: HealthOverride): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${id}/health`, override);
  }
}
