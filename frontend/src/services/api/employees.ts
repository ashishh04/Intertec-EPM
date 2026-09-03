import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * Employees — the mapping between OpenProject identity and EPM's org structure.
 *
 * There is no create, no delete, and no way to change a name or an email. A
 * person is not an EPM resource; only where they sit is. Identity comes from
 * the directory the backend already serves.
 */

export interface EpmEmployee {
  /** The OpenProject user id. EPM mints no id of its own for a person. */
  id: ID;
  name: string;
  email?: string;
  avatarUrl?: string;
  /** `active` is present so the UI can flag an assignment into an archived unit. */
  department?: { id: ID; name: string; active: boolean };
  team?: { id: ID; name: string; active: boolean };
  /** Hours available per week. Always a number; 40 when nothing has been set. */
  hoursCapacity: number;
}

/**
 * Department and team are sent together, always. The backend validates them
 * against each other, and an omitted or empty value clears that side.
 */
export interface MappingInput {
  departmentId?: string;
  teamId?: string;
}

export interface EmployeeFilters {
  departmentId?: string;
  teamId?: string;
  unmapped?: boolean;
  q?: string;
}

export class ApiEmployeeRepository {
  list(filters: EmployeeFilters = {}): Promise<EpmEmployee[]> {
    return apiClient.get<EpmEmployee[]>('/employees', {
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.teamId ? { teamId: filters.teamId } : {}),
      ...(filters.unmapped ? { unmapped: 'true' } : {}),
      ...(filters.q ? { q: filters.q } : {}),
    });
  }

  get(id: ID): Promise<EpmEmployee> {
    return apiClient.get<EpmEmployee>(`/employees/${id}`);
  }

  setMapping(id: ID, input: MappingInput): Promise<EpmEmployee> {
    return apiClient.patch<EpmEmployee>(`/employees/${id}/mapping`, input);
  }

  /**
   * Weekly capacity. Separate from the mapping call, because that one writes
   * department and team as a unit and a capacity edit must not restate them.
   */
  setCapacity(id: ID, hoursCapacity: number): Promise<EpmEmployee> {
    return apiClient.patch<EpmEmployee>(`/employees/${id}/capacity`, { hoursCapacity });
  }

  /** People mapped to a team. Membership is EPM's, never an OpenProject group. */
  teamMembers(teamId: ID): Promise<EpmEmployee[]> {
    return apiClient.get<EpmEmployee[]>(`/teams/${teamId}/members`);
  }
}
