import { apiClient } from './client';
import type { ID, JournalPage, Permission, PermissionGrant, PermissionGrants } from '@/types';

/**
 * Governance (Module 16): EPM's own permission grants, and the instance-wide
 * journal of every change EPM recorded.
 */

export interface JournalQuery {
  entityType?: string;
  /** Actions starting with this, e.g. `account.` or `grant.`. */
  action?: string;
  actorId?: ID;
  projectId?: ID;
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export const governanceService = {
  getPermissionGrants(): Promise<PermissionGrants> {
    return apiClient.get<PermissionGrants>('/admin/permission-grants');
  },

  grantPermission(input: { userId: ID; permission: Permission }): Promise<PermissionGrant> {
    return apiClient.post<PermissionGrant>('/admin/permission-grants', input);
  },

  revokePermission(userId: ID, permission: Permission): Promise<void> {
    return apiClient.delete<void>(
      `/admin/permission-grants/${encodeURIComponent(userId)}/${encodeURIComponent(permission)}`,
    );
  },

  getJournal(query: JournalQuery): Promise<JournalPage> {
    return apiClient.get<JournalPage>('/journal', { ...query });
  },
};
