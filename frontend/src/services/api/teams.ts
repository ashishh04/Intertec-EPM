import { apiClient } from './client';
import type { ID, TeamMemberWorkload } from '@/types';

/**
 * Teams — an EPM-owned domain.
 *
 * Nothing behind these endpoints comes from OpenProject except the two resolved
 * display names: `department.name` and `lead.name`. Only ids are stored.
 *
 * There is no remove method. Teams are archived, not deleted, as departments
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
