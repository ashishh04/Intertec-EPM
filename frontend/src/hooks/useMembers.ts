import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { memberService } from '@/services';
import type { ID } from '@/types';

/**
 * Project membership.
 *
 * Every mutation here changes OpenProject, and several EPM surfaces are derived
 * from the result: the project payload's `memberIds`, the workload list, and a
 * portfolio's member count, capacity total and involved teams. So a write
 * invalidates projects and teams as well as the member list — a stale capacity
 * figure after adding someone is the sort of thing nobody notices is wrong.
 */

export const memberKeys = {
  list: (projectId: ID) => ['members', projectId] as const,
  candidates: (projectId: ID) => ['members', projectId, 'candidates'] as const,
  roles: () => ['members', 'roles'] as const,
};

export function useProjectMembers(projectId?: ID) {
  return useQuery({
    queryKey: memberKeys.list(projectId ?? 'unknown'),
    queryFn: () => memberService.list(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

/** Only fetched while the picker is open — the list is useless until then. */
export function useMemberCandidates(projectId: ID, enabled: boolean) {
  return useQuery({
    queryKey: memberKeys.candidates(projectId),
    queryFn: () => memberService.candidates(projectId),
    enabled,
    staleTime: 30_000,
  });
}

/** Instance configuration, so it is cached for the session. */
export function useProjectRoles(enabled = true) {
  return useQuery({
    queryKey: memberKeys.roles(),
    queryFn: () => memberService.roles(),
    enabled,
    staleTime: Infinity,
  });
}

function useMemberInvalidation(projectId: ID) {
  const client = useQueryClient();

  return () => {
    void client.invalidateQueries({ queryKey: memberKeys.list(projectId) });
    // Adding someone removes them from the candidate list, and vice versa.
    void client.invalidateQueries({ queryKey: memberKeys.candidates(projectId) });
    // `memberIds`, the workload list, and portfolio rollups all read from the
    // same membership collection upstream.
    void client.invalidateQueries({ queryKey: ['projects'] });
    void client.invalidateQueries({ queryKey: ['teams'] });
    void client.invalidateQueries({ queryKey: ['portfolios'] });
    // Adding, removing or re-roling someone changes what they may do in this
    // project, and the permission map is only fetched once per session.
    void client.invalidateQueries({ queryKey: ['current-user'] });
  };
}

export function useAddProjectMember(projectId: ID) {
  const settle = useMemberInvalidation(projectId);

  return useMutation({
    mutationFn: (input: { userId: ID; roleIds: ID[] }) => memberService.add(projectId, input),
    onSuccess: settle,
  });
}

export function useSetMemberRoles(projectId: ID) {
  const settle = useMemberInvalidation(projectId);

  return useMutation({
    mutationFn: (input: { membershipId: ID; roleIds: ID[] }) =>
      memberService.setRoles(projectId, input.membershipId, input.roleIds),
    onSuccess: settle,
  });
}

export function useRemoveProjectMember(projectId: ID) {
  const settle = useMemberInvalidation(projectId);

  return useMutation({
    mutationFn: (membershipId: ID) => memberService.remove(projectId, membershipId),
    onSuccess: settle,
  });
}
