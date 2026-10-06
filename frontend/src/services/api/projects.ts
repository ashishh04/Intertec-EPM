import { apiClient } from './client';
import type { ProjectRepository } from '../repositories';
import type { AuditEvent, AuditPage, ID, Milestone, EpmProject, HealthOverride, ProjectPlanInput } from '@/types';

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
   * Overrides calculated health. Its own endpoint, not part of the project
   * patch: that one is gated on the OpenProject-derived project:edit, and
   * health authority is EPM's.
   *
   * `levels` is the whole override — an omitted criterion is cleared, so
   * `{ levels: {} }` clears every pin. Setting one needs a reason, which is
   * kept with it and shown wherever the overridden value is.
   */
  setHealthOverride(id: ID, override: { levels: HealthOverride; reason?: string }): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${id}/health`, override);
  }

  /** The answer is already recalculated, so it shows what the new plan means. */
  updatePlan(id: ID, plan: ProjectPlanInput): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${id}/plan`, plan);
  }

  recalculateHealth(id: ID): Promise<EpmProject> {
    return apiClient.post<EpmProject>(`/projects/${id}/health/recalculate`);
  }

  getJournal(id: ID, params: { before?: number; limit?: number; action?: string } = {}): Promise<AuditEvent[]> {
    return apiClient.get<AuditEvent[]>(`/projects/${id}/journal`, params);
  }

  /** The journal a numbered page at a time, with its total. */
  getJournalPage(id: ID, params: { page: number; pageSize: number; action?: string }): Promise<AuditPage> {
    return apiClient.get<AuditPage>(`/projects/${id}/journal/page`, params);
  }

  /** The projects directly beneath this one. */
  getChildren(id: ID): Promise<EpmProject[]> {
    return apiClient.get<EpmProject[]>(`/projects/${id}/children`);
  }

  /**
   * Moves the project under another, or to the top level with an empty id.
   * The hierarchy is the instance's own, so this is a real upstream move
   * rather than an EPM-side label.
   */
  setParent(id: ID, parentId: string): Promise<EpmProject> {
    return apiClient.patch<EpmProject>(`/projects/${id}/parent`, { parentId });
  }
}
