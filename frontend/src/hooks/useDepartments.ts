import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { departmentService } from '@/services';
import type { DepartmentInput } from '@/services/api/departments';
import type { ID } from '@/types';

/**
 * Departments.
 *
 * All four mutations invalidate the whole list rather than patching a single
 * entry: archiving moves a department between the two lists, and a rename
 * changes its position in an alphabetically sorted one.
 */

export const departmentKeys = {
  list: (includeInactive: boolean) => ['departments', { includeInactive }] as const,
  all: ['departments'] as const,
  detail: (id: ID) => ['departments', 'detail', id] as const,
};

export function useDepartments(includeInactive = false) {
  return useQuery({
    queryKey: departmentKeys.list(includeInactive),
    queryFn: () => departmentService.list(includeInactive),
    staleTime: 60_000,
  });
}

export function useDepartment(id?: ID) {
  return useQuery({
    queryKey: departmentKeys.detail(id ?? 'unknown'),
    queryFn: () => departmentService.get(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

function useDepartmentInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: departmentKeys.all });
}

export function useCreateDepartment() {
  const settle = useDepartmentInvalidation();

  return useMutation({
    mutationFn: (input: DepartmentInput) => departmentService.create(input),
    onSuccess: () => void settle(),
  });
}

export function useUpdateDepartment() {
  const settle = useDepartmentInvalidation();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<DepartmentInput> }) =>
      departmentService.update(id, input),
    onSuccess: () => void settle(),
  });
}

/** Deactivate or reactivate. There is no delete — see the repository. */
/**
 * Deletes a department outright. The backend refuses while anything still
 * references it, and that refusal names what is in the way.
 */
export function useDeleteDepartment() {
  const settle = useDepartmentInvalidation();

  return useMutation({
    mutationFn: (id: ID) => departmentService.remove(id),
    onSuccess: () => void settle(),
  });
}

export function useSetDepartmentActive() {
  const settle = useDepartmentInvalidation();

  return useMutation({
    mutationFn: ({ id, active }: { id: ID; active: boolean }) =>
      active ? departmentService.restore(id) : departmentService.archive(id),
    onSuccess: () => void settle(),
  });
}
