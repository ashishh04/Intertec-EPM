import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/services/api/client';
import type { ID, ScenarioProjectInput, ScenarioSummary, ScenarioView } from '@/types';

/** Portfolio scenarios (Module 7: BR-220 to BR-222). */

export function useScenarios() {
  return useQuery({ queryKey: ['scenarios'], queryFn: () => apiClient.get<ScenarioSummary[]>('/scenarios') });
}

export function useScenario(id: ID | undefined) {
  return useQuery({ queryKey: ['scenarios', id], queryFn: () => apiClient.get<ScenarioView>(`/scenarios/${id}`), enabled: Boolean(id) });
}

function useScenarioMutation<A, R>(run: (args: A) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => client.invalidateQueries({ queryKey: ['scenarios'] }) });
}

export const useCaptureScenario = () =>
  useScenarioMutation((input: { name: string; portfolioId?: ID; projectIds?: ID[] }) => apiClient.post<ScenarioView>('/scenarios', input));
export const useAdjustScenario = () =>
  useScenarioMutation(({ id, projectId, input }: { id: ID; projectId: ID; input: ScenarioProjectInput }) =>
    apiClient.patch<ScenarioView>(`/scenarios/${id}/projects/${projectId}`, input),
  );
export const useSubmitScenario = () => useScenarioMutation((id: ID) => apiClient.post<ScenarioView>(`/scenarios/${id}/submit`));
export const useDeleteScenario = () => useScenarioMutation((id: ID) => apiClient.delete<void>(`/scenarios/${id}`));
