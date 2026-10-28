import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { governanceService, type JournalQuery } from '@/services/api/governance';
import type { AppRole, ID, Permission } from '@/types';

const governanceKeys = {
  grants: ['governance', 'permission-grants'] as const,
  roles: ['governance', 'app-roles'] as const,
  journal: (query: JournalQuery) => ['governance', 'journal', query] as const,
};

export function usePermissionGrants() {
  return useQuery({
    queryKey: governanceKeys.grants,
    queryFn: () => governanceService.getPermissionGrants(),
  });
}

/**
 * A grant changes what someone may do, and the journal records it: both are
 * refreshed, and the signed-in person's own permissions too, in case they
 * changed their own.
 */
function useAfterGrantChange() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: governanceKeys.grants }),
      client.invalidateQueries({ queryKey: ['governance', 'journal'] }),
      client.invalidateQueries({ queryKey: ['current-user'] }),
    ]);
}

export function useGrantPermission() {
  const refresh = useAfterGrantChange();
  return useMutation({
    mutationFn: (input: { userId: ID; permission: Permission }) => governanceService.grantPermission(input),
    onSuccess: () => void refresh(),
  });
}

export function useRevokePermission() {
  const refresh = useAfterGrantChange();
  return useMutation({
    mutationFn: ({ userId, permission }: { userId: ID; permission: Permission }) =>
      governanceService.revokePermission(userId, permission),
    onSuccess: () => void refresh(),
  });
}

export function useAppRoles() {
  return useQuery({
    queryKey: governanceKeys.roles,
    queryFn: () => governanceService.getAppRoles(),
  });
}

/** A role changes someone's sidebar and permissions; the journal records it. */
export function useSetAppRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: ID; role: Exclude<AppRole, 'admin'> }) =>
      governanceService.setAppRole(userId, role),
    onSuccess: () =>
      void Promise.all([
        client.invalidateQueries({ queryKey: governanceKeys.roles }),
        client.invalidateQueries({ queryKey: ['governance', 'journal'] }),
      ]),
  });
}

export function useJournal(query: JournalQuery) {
  return useQuery({
    queryKey: governanceKeys.journal(query),
    queryFn: () => governanceService.getJournal(query),
    // Paging and filtering keep the previous page on screen until the next
    // arrives, rather than flashing a skeleton for every click.
    placeholderData: keepPreviousData,
  });
}
