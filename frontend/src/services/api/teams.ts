import { apiClient } from './client';
import type { TeamRepository } from '../repositories';
import type { ID, EpmTeam, TeamMemberWorkload } from '@/types';

/** Teams map to OpenProject groups, enriched with EPM-side workload data. */
export class ApiTeamRepository implements TeamRepository {
  getTeams(): Promise<EpmTeam[]> {
    return apiClient.get<EpmTeam[]>('/teams');
  }

  getTeam(id: ID): Promise<EpmTeam> {
    return apiClient.get<EpmTeam>(`/teams/${id}`);
  }

  getWorkloads(teamId?: ID): Promise<TeamMemberWorkload[]> {
    return apiClient.get<TeamMemberWorkload[]>('/teams/workloads', { teamId });
  }
}
