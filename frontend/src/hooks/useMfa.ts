import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { mfaService } from '@/services';
import { sessionKeys } from '@/hooks/useSessions';
import type { AppRole, ID } from '@/types';

/**
 * Two-factor authentication.
 *
 * `useConfirmMfaSetup` deliberately leaves the signed-in person's record alone.
 * That record is what releases the set-up gate (App.tsx), and releasing it the
 * moment the code is right would take away the screen showing their recovery
 * codes, the only time they are ever shown. `useFinishMfaSetup` does it once
 * they have saved them.
 */
const mfaKeys = {
  status: ['auth', 'mfa'] as const,
  admin: ['admin', 'mfa'] as const,
};

export function useMfaStatus() {
  return useQuery({
    queryKey: mfaKeys.status,
    queryFn: () => mfaService.status(),
    // Read when somebody is checking how their account is protected.
    staleTime: 0,
  });
}

export function useStartMfaSetup() {
  return useMutation({
    mutationFn: (password?: string) => mfaService.startSetup(password),
  });
}

export function useConfirmMfaSetup() {
  return useMutation({
    mutationFn: (code: string) => mfaService.confirmSetup(code),
  });
}

/** After the recovery codes are saved: turning it on ended their other sessions, too. */
export function useFinishMfaSetup() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: mfaKeys.status }),
      client.invalidateQueries({ queryKey: sessionKeys.all }),
      client.invalidateQueries({ queryKey: ['current-user'] }),
    ]);
}

export function useRegenerateRecoveryCodes() {
  return useMutation({
    mutationFn: (code: string) => mfaService.regenerateRecoveryCodes(code),
  });
}

export function useDisableMfa() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ code, password }: { code: string; password?: string }) => mfaService.disable(code, password),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: mfaKeys.status }),
        // If their role requires it, this is what holds them at the set-up screen.
        client.invalidateQueries({ queryKey: ['current-user'] }),
      ]),
  });
}

export function useMfaAdmin() {
  return useQuery({
    queryKey: mfaKeys.admin,
    queryFn: () => mfaService.adminView(),
    // Read when deciding whether to reset someone: never a remembered answer.
    staleTime: 0,
  });
}

export function useSaveMfaPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (requiredRoles: AppRole[]) => mfaService.savePolicy(requiredRoles),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: mfaKeys.admin }),
        client.invalidateQueries({ queryKey: mfaKeys.status }),
        client.invalidateQueries({ queryKey: ['governance', 'journal'] }),
        // The administrator may have just required it of themselves.
        client.invalidateQueries({ queryKey: ['current-user'] }),
      ]),
  });
}

export function useResetMfa() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: ID) => mfaService.resetPerson(userId),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: mfaKeys.admin }),
        client.invalidateQueries({ queryKey: ['governance', 'journal'] }),
      ]),
  });
}
