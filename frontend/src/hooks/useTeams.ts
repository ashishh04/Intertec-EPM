import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { teamService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { TeamInput, TeamListOptions } from '@/services/api/teams';
import type { ID } from '@/types';

/**
 * Teams.
 *
 * Every mutation invalidates the whole set rather than one entry: archiving
 * moves a team between the default and archived lists, changing its department
 * moves it between filtered lists, and a rename changes its place in an
 * alphabetical one.
 */

export const teamKeys = {
  all: ['teams'] as const,
  list: (options: TeamListOptions) => ['teams', options] as const,
  detail: (id: ID) => ['teams', 'detail', id] as const,
};

export function useTeams(options: TeamListOptions = {}) {
  return useQuery({
    queryKey: teamKeys.list(options),
    queryFn: () => teamService.list(options),
    staleTime: 60_000,
  });
}

export function useTeam(id?: ID) {
  return useQuery({
    queryKey: teamKeys.detail(id ?? 'unknown'),
    queryFn: () => teamService.get(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

function useTeamInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: teamKeys.all });
}

export function useCreateTeam() {
  const settle = useTeamInvalidation();

  return useMutation({
    mutationFn: (input: TeamInput) => teamService.create(input),
    onSuccess: () => void settle(),
  });
}

export function useUpdateTeam() {
  const settle = useTeamInvalidation();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<TeamInput> }) =>
      teamService.update(id, input),
    onSuccess: () => void settle(),
  });
}

/** Deactivate or reactivate. There is no delete — see the repository. */
export function useSetTeamActive() {
  const settle = useTeamInvalidation();

  return useMutation({
    mutationFn: ({ id, active }: { id: ID; active: boolean }) =>
      active ? teamService.restore(id) : teamService.archive(id),
    onSuccess: () => void settle(),
  });
}

/**
 * Workload per person. Named for its endpoint, but not scoped to a team —
 * membership belongs to Employee Mapping and does not exist yet.
 */
export function useTeamWorkloads(teamId?: ID) {
  return useQuery({
    queryKey: queryKeys.teamWorkloads(teamId),
    queryFn: () => teamService.getWorkloads(teamId),
    staleTime: 120_000,
  });
}
