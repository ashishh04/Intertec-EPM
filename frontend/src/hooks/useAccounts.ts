import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/services/api/client';
import { accountService } from '@/services';
import type { AccountInput } from '@/services/api/accounts';
import type { ID } from '@/types';

/**
 * User accounts.
 *
 * Every mutation changes OpenProject, and several EPM surfaces read the same
 * people: the employee list, the user directory behind every avatar, project
 * members and the workload rollups. So a write invalidates all of them rather
 * than just the account list.
 */

export const accountKeys = {
  list: () => ['accounts'] as const,
  detail: (id: ID) => ['accounts', id] as const,
};

/**
 * The directory is admin-only upstream, so 403 is a normal answer for most
 * people rather than a fault, and is not retried.
 */
export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: accountKeys.list(),
    queryFn: () => accountService.list(),
    enabled,
    staleTime: 30_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 403) && failureCount < 1,
  });
}

function useAccountInvalidation() {
  const client = useQueryClient();

  return () => {
    void client.invalidateQueries({ queryKey: accountKeys.list() });
    // A new or renamed person appears in the employee list and the directory
    // that every avatar and member row reads from.
    void client.invalidateQueries({ queryKey: ['employees'] });
    void client.invalidateQueries({ queryKey: ['users'] });
    void client.invalidateQueries({ queryKey: ['members'] });
    void client.invalidateQueries({ queryKey: ['teams'] });
  };
}

export function useCreateAccount() {
  const settle = useAccountInvalidation();

  return useMutation({
    mutationFn: (input: AccountInput) => accountService.create(input),
    onSuccess: settle,
  });
}

export function useUpdateAccount() {
  const settle = useAccountInvalidation();

  return useMutation({
    mutationFn: (vars: { id: ID; patch: Partial<AccountInput> }) =>
      accountService.update(vars.id, vars.patch),
    onSuccess: settle,
  });
}

/** Deactivate and reactivate, as one mutation because they are one decision. */
export function useSetAccountLocked() {
  const settle = useAccountInvalidation();

  return useMutation({
    mutationFn: (vars: { id: ID; locked: boolean }) =>
      vars.locked ? accountService.lock(vars.id) : accountService.unlock(vars.id),
    onSuccess: settle,
  });
}

export function useDeleteAccount() {
  const settle = useAccountInvalidation();

  return useMutation({
    mutationFn: (id: ID) => accountService.remove(id),
    onSuccess: settle,
  });
}
