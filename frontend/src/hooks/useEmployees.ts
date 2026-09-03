import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { employeeService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import { departmentKeys } from '@/hooks/useDepartments';
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

/**
 * What a write to an employee invalidates.
 *
 * Beyond the employee list: team and department totals are sums over these
 * rows, the workload endpoint divides by capacity, and the directory carries
 * the department name that the profile and settings pages read.
 */
function useEmployeeInvalidation() {
  const client = useQueryClient();

  return () => {
    void client.invalidateQueries({ queryKey: employeeKeys.all });
    // `teamKeys.all` is ['teams'], which is a prefix of the workload keys
    // ['teams','workloads',id] — so team totals and every scoped workload are
    // both covered by this one line.
    void client.invalidateQueries({ queryKey: teamKeys.all });
    void client.invalidateQueries({ queryKey: departmentKeys.all });
    void client.invalidateQueries({ queryKey: queryKeys.users });
    void client.invalidateQueries({ queryKey: queryKeys.currentUser });
  };
}

export function useSetMapping() {
  const settle = useEmployeeInvalidation();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: MappingInput }) =>
      employeeService.setMapping(id, input),
    onSuccess: settle,
  });
}

export function useSetCapacity() {
  const settle = useEmployeeInvalidation();

  return useMutation({
    mutationFn: ({ id, hoursCapacity }: { id: ID; hoursCapacity: number }) =>
      employeeService.setCapacity(id, hoursCapacity),
    onSuccess: settle,
  });
}
