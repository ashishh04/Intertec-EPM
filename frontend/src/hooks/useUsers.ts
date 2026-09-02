import { useQuery } from '@tanstack/react-query';
import { userService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, EpmUser } from '@/types';

export function useCurrentUser(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: () => userService.getCurrentUser(),
    // Asking before a session exists just 401s; AuthProvider gates on this.
    enabled: options.enabled ?? true,
    staleTime: Infinity,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => userService.getUsers(),
    staleTime: 300_000,
  });
}

/** Convenience lookup so lists can resolve assignees without extra requests. */
export function useUserMap(): Map<ID, EpmUser> {
  const { data } = useUsers();
  return new Map((data ?? []).map((user) => [user.id, user]));
}
