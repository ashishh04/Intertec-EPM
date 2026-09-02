import { apiClient } from './client';
import type { SprintRepository } from '../repositories';
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

  getActiveSprint(): Promise<EpmSprint> {
    return apiClient.get<EpmSprint>('/sprints/active');
  }
}
