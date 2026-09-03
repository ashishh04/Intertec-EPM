import { apiClient } from './client';
import type { EpmMemberCandidate, EpmProjectMember, EpmRole, ID } from '@/types';

/**
 * Project membership.
 *
 * Every call here writes through to OpenProject, which is where memberships
 * live. Nothing is stored on the EPM side, so there is no local copy to keep in
 * step — a change shows up everywhere that reads members on the next fetch,
 * including the workload list and the portfolio capacity rollups, which derive
 * from the same collection.
 *
 * The write paths take `membershipId`, not `userId`: the membership is the
 * thing being changed, and using the person's id instead is the easy way to
 * act on the wrong record.
 */
export class ApiMemberRepository {
  list(projectId: ID): Promise<EpmProjectMember[]> {
    return apiClient.get<EpmProjectMember[]>(`/projects/${projectId}/members`);
  }

  /** People who may still be added — neither locked nor already members. */
  candidates(projectId: ID): Promise<EpmMemberCandidate[]> {
    return apiClient.get<EpmMemberCandidate[]>(`/projects/${projectId}/members/candidates`);
  }

  /** Roles grantable on a project. Instance-wide, so not scoped to one. */
  roles(): Promise<EpmRole[]> {
    return apiClient.get<EpmRole[]>('/project-roles');
  }

  add(projectId: ID, input: { userId: ID; roleIds: ID[] }): Promise<EpmProjectMember> {
    return apiClient.post<EpmProjectMember>(`/projects/${projectId}/members`, input);
  }

  setRoles(projectId: ID, membershipId: ID, roleIds: ID[]): Promise<EpmProjectMember> {
    return apiClient.patch<EpmProjectMember>(`/projects/${projectId}/members/${membershipId}`, {
      roleIds,
    });
  }

  remove(projectId: ID, membershipId: ID): Promise<void> {
    return apiClient.delete<void>(`/projects/${projectId}/members/${membershipId}`);
  }
}
