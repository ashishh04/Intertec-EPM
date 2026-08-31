import { useQuery } from '@tanstack/react-query';
import { userService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, NexusUser } from '@/types';

export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: () => userService.getCurrentUser(),
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

export function useUser(id?: ID) {
  return useQuery({
    queryKey: queryKeys.user(id ?? 'unknown'),
    queryFn: () => userService.getUser(id!),
    enabled: Boolean(id),
    staleTime: 300_000,
  });
}

/** Convenience lookup so lists can resolve assignees without extra requests. */
export function useUserMap(): Map<ID, NexusUser> {
  const { data } = useUsers();
  return new Map((data ?? []).map((user) => [user.id, user]));
}
