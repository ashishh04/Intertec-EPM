import { apiClient } from './client';
import type { EpmPlaceholderPerson, ID, PlaceholderPersonInput } from '@/types';

/**
 * Placeholder people — EPM's own, not OpenProject's.
 *
 * OpenProject gates creating a placeholder user behind an Enterprise licence,
 * so on a Community instance the feature is simply absent. These are EPM
 * records: they carry a team, a department and weekly capacity, so headcount
 * that is planned but not yet hired counts toward team workload and portfolio
 * capacity. They cannot be a work package assignee — only OpenProject decides
 * who is assignable, and it will not accept someone it has never heard of.
 */
export class ApiPlaceholderPersonRepository {
  list(params: { includeConverted?: boolean; teamId?: ID; departmentId?: ID } = {}) {
    return apiClient.get<EpmPlaceholderPerson[]>('/placeholder-people', {
      ...(params.includeConverted ? { includeConverted: 'true' } : {}),
      ...(params.teamId ? { teamId: params.teamId } : {}),
      ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    });
  }

  create(input: PlaceholderPersonInput) {
    return apiClient.post<EpmPlaceholderPerson>('/placeholder-people', input);
  }

  update(id: ID, input: Partial<PlaceholderPersonInput>) {
    return apiClient.patch<EpmPlaceholderPerson>(`/placeholder-people/${id}`, input);
  }

  /**
   * Records that this placeholder has become a real person, carrying its team,
   * department and capacity onto their profile.
   */
  convert(id: ID, userId: ID) {
    return apiClient.post<EpmPlaceholderPerson>(`/placeholder-people/${id}/convert`, { userId });
  }

  remove(id: ID) {
    return apiClient.delete<void>(`/placeholder-people/${id}`);
  }
}
