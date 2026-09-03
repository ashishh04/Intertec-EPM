import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { employeeService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import { teamKeys } from '@/hooks/useTeams';
import type { EmployeeFilters, MappingInput } from '@/services/api/employees';
import type { ID } from '@/types';

/**
 * Employee mapping.
 *
 * A mapping write reaches further than the employee list: it changes a team's
 * member count, and it changes the department name the directory reports for
 * that person — which the profile and settings pages read. All three are
 * invalidated together.
 */

export const employeeKeys = {
  all: ['employees'] as const,
  list: (filters: EmployeeFilters) => ['employees', filters] as const,
  detail: (id: ID) => ['employees', 'detail', id] as const,
  teamMembers: (teamId: ID) => ['employees', 'team-members', teamId] as const,
};

export function useEmployees(filters: EmployeeFilters = {}) {
  return useQuery({
    queryKey: employeeKeys.list(filters),
    queryFn: () => employeeService.list(filters),
    staleTime: 30_000,
  });
}

export function useTeamMembers(teamId?: ID) {
  return useQuery({
    queryKey: employeeKeys.teamMembers(teamId ?? 'unknown'),
    queryFn: () => employeeService.teamMembers(teamId!),
    enabled: Boolean(teamId),
    staleTime: 30_000,
  });
}

export function useSetMapping() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: MappingInput }) =>
      employeeService.setMapping(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: employeeKeys.all });
      // Member counts live on the team list.
      void client.invalidateQueries({ queryKey: teamKeys.all });
      // The directory carries the department name, and is what the profile and
      // settings pages read.
      void client.invalidateQueries({ queryKey: queryKeys.users });
      void client.invalidateQueries({ queryKey: queryKeys.currentUser });
    },
  });
}
