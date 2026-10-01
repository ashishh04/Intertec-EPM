import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { placeholderPersonService } from '@/services';
import type { ID, PlaceholderPersonInput } from '@/types';

/**
 * Placeholder people.
 *
 * A write changes planned headcount, so it clears the surfaces that sum
 * capacity — team workloads and the employee directory — alongside its own.
 */
const PLACEHOLDER_WRITE = [['placeholder-people'], ['teams'], ['employees'], ['analytics']];

export function usePlaceholderPeople(
  params: { includeConverted?: boolean; teamId?: ID; departmentId?: ID } = {},
) {
  return useQuery({
    queryKey: ['placeholder-people', params],
    queryFn: () => placeholderPersonService.list(params),
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return () => PLACEHOLDER_WRITE.forEach((key) => client.invalidateQueries({ queryKey: key }));
}

export function useCreatePlaceholderPerson() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: PlaceholderPersonInput) => placeholderPersonService.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdatePlaceholderPerson() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<PlaceholderPersonInput> & { id: ID }) =>
      placeholderPersonService.update(id, input),
    onSuccess: invalidate,
  });
}

export function useConvertPlaceholderPerson() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, userId }: { id: ID; userId: ID }) =>
      placeholderPersonService.convert(id, userId),
    onSuccess: invalidate,
  });
}

export function useDeletePlaceholderPerson() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: ID) => placeholderPersonService.remove(id),
    onSuccess: invalidate,
  });
}
