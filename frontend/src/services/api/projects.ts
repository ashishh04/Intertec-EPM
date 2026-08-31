import { apiClient } from './client';
import type { ProjectRepository } from '../repositories';
import type { ID, Milestone, NexusProject } from '@/types';

/**
 * Projects arrive from the Nexus backend already normalized. The backend owns
 * the OpenProject call, its HAL parsing and its pagination.
 */
export class ApiProjectRepository implements ProjectRepository {
  getProjects(params: { search?: string; status?: string[] } = {}): Promise<NexusProject[]> {
    return apiClient.get<NexusProject[]>('/projects', {
      search: params.search,
      status: params.status,
    });
  }

  getProject(id: ID): Promise<NexusProject> {
    return apiClient.get<NexusProject>(`/projects/${id}`);
  }

  getMilestones(projectId: ID): Promise<Milestone[]> {
    return apiClient.get<Milestone[]>(`/projects/${projectId}/milestones`);
  }

  updateProject(id: ID, patch: Partial<NexusProject>): Promise<NexusProject> {
    return apiClient.patch<NexusProject>(`/projects/${id}`, patch);
  }
}
