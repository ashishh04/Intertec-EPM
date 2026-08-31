import { apiClient } from './client';
import type { SprintRepository } from '../repositories';
import type { ID, NexusSprint } from '@/types';

/**
 * Sprints are a Nexus concept layered over OpenProject versions and backlogs.
 * The backend decides how they are represented; the UI only sees NexusSprint.
 */
export class ApiSprintRepository implements SprintRepository {
  getSprints(): Promise<NexusSprint[]> {
    return apiClient.get<NexusSprint[]>('/sprints');
  }

  getSprint(id: ID): Promise<NexusSprint> {
    return apiClient.get<NexusSprint>(`/sprints/${id}`);
  }

  getActiveSprint(): Promise<NexusSprint> {
    return apiClient.get<NexusSprint>('/sprints/active');
  }
}
