import { apiClient } from './client';
import type { TeamRepository } from '../repositories';
import type { ID, NexusTeam, TeamMemberWorkload } from '@/types';

/** Teams map to OpenProject groups, enriched with Nexus-side workload data. */
export class ApiTeamRepository implements TeamRepository {
  getTeams(): Promise<NexusTeam[]> {
    return apiClient.get<NexusTeam[]>('/teams');
  }

  getTeam(id: ID): Promise<NexusTeam> {
    return apiClient.get<NexusTeam>(`/teams/${id}`);
  }

  getWorkloads(teamId?: ID): Promise<TeamMemberWorkload[]> {
    return apiClient.get<TeamMemberWorkload[]>('/teams/workloads', { teamId });
  }
}
