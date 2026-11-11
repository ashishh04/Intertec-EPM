import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { riskService } from '@/services';
import type { MilestoneListOptions, RiskListOptions } from '@/services/api/risks';
import type { ID, RiskAssessmentInput } from '@/types';

/**
 * The risk register, and milestones across projects.
 *
 * Saving an assessment can change the risk's priority (it follows the rating),
 * so tasks and dashboards are refreshed with the register.
 */

export const riskKeys = {
  all: ['risks'] as const,
  register: (options: RiskListOptions) => ['risks', 'register', options] as const,
  milestones: (options: MilestoneListOptions) => ['milestones', options] as const,
};

export function useRiskRegister(options: RiskListOptions = {}) {
  return useQuery({
    queryKey: riskKeys.register(options),
    queryFn: () => riskService.register(options),
    staleTime: 30_000,
  });
}

export function useSaveRiskAssessment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ workPackageId, input }: { workPackageId: ID; input: RiskAssessmentInput }) =>
      riskService.saveAssessment(workPackageId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: riskKeys.all });
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: ['insights'] });
    },
  });
}

export function useMilestones(options: MilestoneListOptions = {}) {
  return useQuery({
    queryKey: riskKeys.milestones(options),
    queryFn: () => riskService.milestones(options),
    staleTime: 60_000,
  });
}
