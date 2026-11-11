import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { statusReportService } from '@/services/api/status-reports';
import type { ID, StatusReportInput } from '@/types';

export const statusReportKeys = {
  all: ['status-reports'] as const,
  list: (scopeKind: string, scopeId: ID, page: number) => ['status-reports', scopeKind, scopeId, page] as const,
};

export function useStatusReports(scopeKind: 'project' | 'portfolio', scopeId?: ID, page = 1) {
  return useQuery({
    queryKey: statusReportKeys.list(scopeKind, scopeId ?? 'unknown', page),
    queryFn: () => statusReportService.list(scopeKind, scopeId!, page),
    enabled: Boolean(scopeId),
    staleTime: 30_000,
  });
}

export function useStatusReportMutations() {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: statusReportKeys.all });
  return {
    create: useMutation({ mutationFn: (input: StatusReportInput) => statusReportService.create(input), onSuccess: settle }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: ID; input: Partial<Omit<StatusReportInput, 'scopeKind' | 'scopeId'>> }) =>
        statusReportService.update(id, input),
      onSuccess: settle,
    }),
    remove: useMutation({ mutationFn: (id: ID) => statusReportService.remove(id), onSuccess: settle }),
  };
}
