import { useQuery } from '@tanstack/react-query';
import { teamService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

export function useTeams() {
  return useQuery({
    queryKey: queryKeys.teams,
    queryFn: () => teamService.getTeams(),
    staleTime: 120_000,
  });
}

export function useTeam(id?: ID) {
  return useQuery({
    queryKey: queryKeys.team(id ?? 'unknown'),
    queryFn: () => teamService.getTeam(id!),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
}

export function useTeamWorkloads(teamId?: ID) {
  return useQuery({
    queryKey: queryKeys.teamWorkloads(teamId),
    queryFn: () => teamService.getWorkloads(teamId),
    staleTime: 120_000,
  });
}
