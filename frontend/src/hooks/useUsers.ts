import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { userService } from '@/services';
import { apiClient } from '@/services/api/client';
import type { PasswordPolicy } from '@/types';
import type { ProfileInput } from '@/services/repositories';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, EpmUser } from '@/types';

/**
 * The password rules this instance enforces.
 *
 * Fetched rather than declared in the form, so the requirements shown can never
 * contradict the ones applied — an administrator changing the policy changes
 * both at once. `minAdheredRules` is how many of `activeRules` are required,
 * not a flag: zero means only the length applies.
 */
export function usePasswordPolicy() {
  return useQuery({
    queryKey: ['password-policy'] as const,
    queryFn: () => apiClient.get<PasswordPolicy>('/me/password-policy'),
    staleTime: 300_000,
  });
}

export function useCurrentUser(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: () => userService.getCurrentUser(),
    // Asking before a session exists just 401s; AuthProvider gates on this.
    enabled: options.enabled ?? true,
    // Not Infinity: a name or email changed elsewhere — by an administrator,
    // or in another tab — would otherwise never appear for the rest of the
    // session. Five minutes is long enough that no page refetches it twice.
    staleTime: 300_000,
  });
}

/**
 * The timezone names the instance accepts.
 *
 * Deliberately not `Intl.supportedValuesOf('timeZone')`: that reports
 * canonical IANA ids, which for India is Asia/Calcutta, and the instance
 * accepts only Asia/Kolkata. A picker built from the browser's list offers
 * choices every one of which is refused on save.
 */
export function useTimezones() {
  return useQuery({
    queryKey: ['timezones'],
    queryFn: () => userService.getTimezones(),
    // The set changes with a tzdata release, not with anything a person does.
    staleTime: Infinity,
  });
}

/**
 * Edits the signed-in person's own details.
 *
 * Their name labels every task they are assigned and every team they sit in,
 * so both their own record and the directory the rest of the product reads are
 * dropped on success. Without the second, a rename would show in Settings and
 * nowhere else.
 */
export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ProfileInput) => userService.updateProfile(input),
    onSuccess: async (updated) => {
      client.setQueryData(queryKeys.currentUser, updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.currentUser }),
        client.invalidateQueries({ queryKey: queryKeys.users }),
        // Assignee and member names are rendered from rows these queries hold.
        client.invalidateQueries({ queryKey: ['tasks'] }),
        client.invalidateQueries({ queryKey: ['teams'] }),
        client.invalidateQueries({ queryKey: ['employees'] }),
      ]);
    },
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
