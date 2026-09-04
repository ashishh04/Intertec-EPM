import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * Departments — an EPM-owned domain.
 *
 * Unlike every other repository here, nothing behind this endpoint comes from
 * OpenProject. The one exception is `manager.name`, which the backend resolves
 * from the user directory at read time; only the id is stored.
 *
 * Archiving is the ordinary lifecycle. `remove` deletes outright and is refused
 * while anything still references the record, because
 * teams and employee mappings will reference them.
 */

export interface EpmDepartment {
  id: ID;
  name: string;
  code: string;
  description?: string;
  manager?: { id: ID; name: string };
  /**
   * People mapped to this department and their weekly hours summed. Counted
   * from the department directly, so someone with no team still counts.
   */
  memberCount: number;
  capacityHours: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentInput {
  name: string;
  code: string;
  description?: string;
  managerId?: string;
}

export class ApiDepartmentRepository {
  list(includeInactive = false): Promise<EpmDepartment[]> {
    return apiClient.get<EpmDepartment[]>(
      '/departments',
      includeInactive ? { includeInactive: 'true' } : undefined,
    );
  }

  get(id: ID): Promise<EpmDepartment> {
    return apiClient.get<EpmDepartment>(`/departments/${id}`);
  }

  create(input: DepartmentInput): Promise<EpmDepartment> {
    return apiClient.post<EpmDepartment>('/departments', input);
  }

  update(id: ID, input: Partial<DepartmentInput>): Promise<EpmDepartment> {
    return apiClient.patch<EpmDepartment>(`/departments/${id}`, input);
  }

  /**
   * Deletes outright. Refused while anything still references the department,
   * because detaching people to make a delete succeed loses real data.
   */
  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/departments/${id}`);
  }

  archive(id: ID): Promise<EpmDepartment> {
    return apiClient.patch<EpmDepartment>(`/departments/${id}/archive`);
  }

  restore(id: ID): Promise<EpmDepartment> {
    return apiClient.patch<EpmDepartment>(`/departments/${id}/restore`);
  }
}
