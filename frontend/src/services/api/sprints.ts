import { ApiError, apiClient } from './client';
import type { CreateSprintInput, SprintRepository } from '../repositories';
import type { ID, EpmSprint } from '@/types';

/**
 * Sprints are a EPM concept layered over OpenProject versions and backlogs.
 * The backend decides how they are represented; the UI only sees EpmSprint.
 */
export class ApiSprintRepository implements SprintRepository {
  getSprints(): Promise<EpmSprint[]> {
    return apiClient.get<EpmSprint[]>('/sprints');
  }

  getSprint(id: ID): Promise<EpmSprint> {
    return apiClient.get<EpmSprint>(`/sprints/${id}`);
  }

  async getActiveSprint(): Promise<EpmSprint | null> {
    // The backend answers 404 when no sprint is running. That is an answer,
    // not a fault, so it is folded into `null` here — otherwise React Query
    // retries it and every caller has to special-case the rejection.
    try {
      return await apiClient.get<EpmSprint>('/sprints/active');
    } catch (error) {
      if (error instanceof ApiError && error.isNotFound) return null;
      throw error;
    }
  }

  createSprint(input: CreateSprintInput): Promise<{ id: ID; name: string }> {
    return apiClient.post<{ id: ID; name: string }>('/sprints', input);
  }

  setSprintState(id: ID, state: 'active' | 'completed'): Promise<EpmSprint> {
    return apiClient.patch<EpmSprint>(`/sprints/${id}`, { state });
  }
}
