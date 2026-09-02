import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * OpenProject reference data, unreduced.
 *
 * The EPM domain models collapse statuses, types and priorities into fixed
 * unions for consistent styling. That is right for *display* and wrong for
 * *choice*: this instance defines 14 statuses behind 6 EPM values, so a picker
 * built from the union cannot express what OpenProject accepts. Anything that
 * writes a value reads its options from here.
 */

export interface CatalogValue {
  id: ID;
  name: string;
  position?: number;
}

export interface StatusValue extends CatalogValue {
  isClosed: boolean;
  isDefault?: boolean;
}

export interface TypeValue extends CatalogValue {
  isMilestone: boolean;
  isDefault?: boolean;
  color?: string;
}

export interface VersionValue extends CatalogValue {
  status?: string;
}

export class ApiCatalogRepository {
  getStatuses(): Promise<StatusValue[]> {
    return apiClient.get<StatusValue[]>('/catalog/statuses');
  }

  getTypes(): Promise<TypeValue[]> {
    return apiClient.get<TypeValue[]>('/catalog/types');
  }

  getPriorities(): Promise<CatalogValue[]> {
    return apiClient.get<CatalogValue[]>('/catalog/priorities');
  }

  getRoles(): Promise<CatalogValue[]> {
    return apiClient.get<CatalogValue[]>('/catalog/roles');
  }

  /** Only the types this project enables; the instance list produces 422s. */
  getProjectTypes(projectId: ID): Promise<TypeValue[]> {
    return apiClient.get<TypeValue[]>(`/catalog/projects/${projectId}/types`);
  }

  getProjectVersions(projectId: ID): Promise<VersionValue[]> {
    return apiClient.get<VersionValue[]>(`/catalog/projects/${projectId}/versions`);
  }

  getProjectCategories(projectId: ID): Promise<CatalogValue[]> {
    return apiClient.get<CatalogValue[]>(`/catalog/projects/${projectId}/categories`);
  }

  /** Membership-aware, unlike the instance-wide user list. */
  getProjectAssignees(projectId: ID): Promise<CatalogValue[]> {
    return apiClient.get<CatalogValue[]>(`/catalog/projects/${projectId}/assignees`);
  }
}
