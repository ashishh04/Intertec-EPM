import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { sessionService } from '@/services';
import type { ID } from '@/types';

/**
 * Where this person is signed in.
 *
 * Kept deliberately fresh — `staleTime: 0` — because the list is read precisely
 * when somebody is suspicious about it. A cached answer from five minutes ago is
 * the wrong thing to show to a person checking whether an unfamiliar device is
 * still there.
 */
export const sessionKeys = {
  all: ['sessions'] as const,
};

export function useSessions() {
  return useQuery({
    queryKey: sessionKeys.all,
    queryFn: () => sessionService.list(),
    staleTime: 0,
  });
}

export function useRevokeSession() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => sessionService.revoke(id),
    onSuccess: () => client.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}

export function useRevokeOtherSessions() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => sessionService.revokeOthers(),
    onSuccess: () => client.invalidateQueries({ queryKey: sessionKeys.all }),
  });
}
