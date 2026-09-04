import { apiClient } from './client';
import type { ID, TeamMemberWorkload } from '@/types';

/**
 * Teams — an EPM-owned domain.
 *
 * Nothing behind these endpoints comes from OpenProject except the two resolved
 * display names: `department.name` and `lead.name`. Only ids are stored.
 *
 * Archiving is the ordinary lifecycle. `remove` deletes outright and is refused
 * while anyone is still on the team, as departments
 * and projects are.
 *
 * `getWorkloads` is about people rather than teams despite the path, and is
 * what the project team tab uses. Team membership belongs to Employee Mapping
 * and does not exist yet.
 */

export interface EpmTeam {
  id: ID;
  name: string;
  code: string;
  description?: string;
  /** `active` is present because a team outlives its department's archival. */
  department?: { id: ID; name: string; active: boolean };
  lead?: { id: ID; name: string };
  /**
   * People mapped to this team, counted from EPM's employee mapping — never
   * from OpenProject group membership, which is what teams were read from
   * before.
   */
  memberCount: number;
  /** Members' weekly hours summed. Zero for an empty team, never absent. */
  capacityHours: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name: string;
  code: string;
  description?: string;
  departmentId?: string;
  leadId?: string;
}

export interface TeamListOptions {
  includeInactive?: boolean;
  departmentId?: string;
}

export class ApiTeamRepository {
  list(options: TeamListOptions = {}): Promise<EpmTeam[]> {
    return apiClient.get<EpmTeam[]>('/teams', {
      ...(options.includeInactive ? { includeInactive: 'true' } : {}),
      ...(options.departmentId ? { departmentId: options.departmentId } : {}),
    });
  }

  get(id: ID): Promise<EpmTeam> {
    return apiClient.get<EpmTeam>(`/teams/${id}`);
  }

  create(input: TeamInput): Promise<EpmTeam> {
    return apiClient.post<EpmTeam>('/teams', input);
  }

  update(id: ID, input: Partial<TeamInput>): Promise<EpmTeam> {
    return apiClient.patch<EpmTeam>(`/teams/${id}`, input);
  }

  /**
   * Deletes outright. Refused while anything still references the team,
   * because detaching people to make a delete succeed loses real data.
   */
  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/teams/${id}`);
  }

  archive(id: ID): Promise<EpmTeam> {
    return apiClient.patch<EpmTeam>(`/teams/${id}/archive`);
  }

  restore(id: ID): Promise<EpmTeam> {
    return apiClient.patch<EpmTeam>(`/teams/${id}/restore`);
  }

  getWorkloads(teamId?: ID): Promise<TeamMemberWorkload[]> {
    return apiClient.get<TeamMemberWorkload[]>('/teams/workloads', { teamId });
  }
}
