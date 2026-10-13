import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/services/api/client';
import type {
  BillingMilestoneView,
  BillingView,
  CashFlowView,
  CurrencyList,
  ExchangeRateInput,
  ExchangeRateView,
  FinanceBatchView,
  FinanceSettings,
  ForecastView,
  ID,
  MarginView,
  PhasingView,
  ProjectContract,
  ProjectContractInput,
  RateCardInput,
  RateCardView,
} from '@/types';

/**
 * Finance (Module 11, part 2): phasing and cash flow (BR-310, BR-311), margin
 * and forecast (BR-318, BR-319), currencies (BR-320, BR-321), billing and its
 * transfer (BR-322, BR-323). Reading needs `finance:view`.
 */

/** A figure's scope: one project, a portfolio, or every project the reader can see. */
export interface FinanceScope {
  projectId?: ID;
  portfolioId?: ID;
}

const params = (scope: FinanceScope) => {
  const out: Record<string, string> = {};
  if (scope.projectId) out.projectId = String(scope.projectId);
  else if (scope.portfolioId) out.portfolioId = String(scope.portfolioId);
  return out;
};

export const financeKeys = {
  all: ['finance'] as const,
  settings: () => ['finance', 'settings'] as const,
  currencies: () => ['finance', 'currencies'] as const,
  rates: () => ['finance', 'rates'] as const,
  cards: () => ['finance', 'rate-cards'] as const,
  figure: (kind: string, scope: FinanceScope) => ['finance', kind, params(scope)] as const,
  project: (kind: string, projectId: ID, extra?: unknown) => ['finance', 'project', projectId, kind, extra] as const,
  batches: () => ['finance', 'batches'] as const,
};

export function useFinanceSettings(enabled = true) {
  return useQuery({ queryKey: financeKeys.settings(), queryFn: () => apiClient.get<FinanceSettings>('/finance/settings'), enabled });
}

export function useCurrencies() {
  return useQuery({ queryKey: financeKeys.currencies(), queryFn: () => apiClient.get<CurrencyList>('/finance/currencies'), staleTime: 60_000 });
}

export function useExchangeRates(enabled = true) {
  return useQuery({ queryKey: financeKeys.rates(), queryFn: () => apiClient.get<ExchangeRateView[]>('/finance/rates'), enabled });
}

export function useRateCards(enabled = true) {
  return useQuery({ queryKey: financeKeys.cards(), queryFn: () => apiClient.get<RateCardView[]>('/finance/rate-cards'), enabled });
}

export function useCashFlow(scope: FinanceScope, enabled = true) {
  return useQuery({ queryKey: financeKeys.figure('cash-flow', scope), queryFn: () => apiClient.get<CashFlowView>('/finance/cash-flow', params(scope)), enabled });
}

export function useMargin(scope: FinanceScope, enabled = true) {
  return useQuery({ queryKey: financeKeys.figure('margin', scope), queryFn: () => apiClient.get<MarginView>('/finance/margin', params(scope)), enabled });
}

export function useForecast(scope: FinanceScope, enabled = true) {
  return useQuery({ queryKey: financeKeys.figure('forecast', scope), queryFn: () => apiClient.get<ForecastView>('/finance/forecast', params(scope)), enabled });
}

export function useContract(projectId: ID | undefined) {
  return useQuery({
    queryKey: financeKeys.project('contract', projectId ?? ''),
    queryFn: () => apiClient.get<ProjectContract>(`/finance/projects/${projectId}/contract`),
    enabled: Boolean(projectId),
  });
}

export function usePhasing(projectId: ID | undefined) {
  return useQuery({
    queryKey: financeKeys.project('phasing', projectId ?? ''),
    queryFn: () => apiClient.get<PhasingView>(`/finance/projects/${projectId}/phasing`),
    enabled: Boolean(projectId),
  });
}

export function useMilestones(projectId: ID | undefined) {
  return useQuery({
    queryKey: financeKeys.project('milestones', projectId ?? ''),
    queryFn: () => apiClient.get<BillingMilestoneView[]>(`/finance/projects/${projectId}/milestones`),
    enabled: Boolean(projectId),
  });
}

export function useBilling(projectId: ID | undefined, from: string, to: string) {
  return useQuery({
    queryKey: financeKeys.project('billing', projectId ?? '', { from, to }),
    queryFn: () => apiClient.get<BillingView>(`/finance/projects/${projectId}/billing`, { from, to }),
    enabled: Boolean(projectId && from && to && from <= to),
  });
}

export function useBatches(enabled = true) {
  return useQuery({ queryKey: financeKeys.batches(), queryFn: () => apiClient.get<FinanceBatchView[]>('/finance/batches'), enabled });
}

/** Any finance write: every finance figure may have moved. */
function useFinanceMutation<A, R>(run: (args: A) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: financeKeys.all }),
  });
}

export const useSaveFinanceSettings = () =>
  useFinanceMutation((input: Pick<FinanceSettings, 'confidence' | 'horizonMonths' | 'endpoint'>) => apiClient.put<FinanceSettings>('/finance/settings', input));
export const useAddRate = () => useFinanceMutation((input: ExchangeRateInput) => apiClient.post<ExchangeRateView>('/finance/rates', input));
export const useSaveRateCard = () =>
  useFinanceMutation(({ id, input }: { id?: ID; input: RateCardInput }) =>
    id ? apiClient.put<RateCardView>(`/finance/rate-cards/${id}`, input) : apiClient.post<RateCardView>('/finance/rate-cards', input),
  );
export const useDeleteRateCard = () => useFinanceMutation((id: ID) => apiClient.delete<void>(`/finance/rate-cards/${id}`));
export const useSaveContract = () =>
  useFinanceMutation(({ projectId, input }: { projectId: ID; input: ProjectContractInput }) =>
    apiClient.patch<ProjectContract>(`/finance/projects/${projectId}/contract`, input),
  );
export const useSavePhasing = () =>
  useFinanceMutation(({ projectId, phases }: { projectId: ID; phases: { month: string; amount: number }[] | null }) =>
    phases
      ? apiClient.put<PhasingView>(`/finance/projects/${projectId}/phasing`, { phases })
      : apiClient.delete<PhasingView>(`/finance/projects/${projectId}/phasing`),
  );
export const useSetMilestone = () =>
  useFinanceMutation(({ projectId, workPackageId, amount }: { projectId: ID; workPackageId: ID; amount: number | null }) =>
    amount === null
      ? apiClient.delete<BillingMilestoneView[]>(`/finance/projects/${projectId}/milestones/${workPackageId}`)
      : apiClient.put<BillingMilestoneView[]>(`/finance/projects/${projectId}/milestones/${workPackageId}`, { amount }),
  );
export const useGenerateBilling = () =>
  useFinanceMutation(({ projectId, from, to }: { projectId: ID; from: string; to: string }) =>
    apiClient.post<BillingView>(`/finance/projects/${projectId}/billing`, { from, to }),
  );
export const useCreateBatch = () => useFinanceMutation((projectId: ID | undefined) => apiClient.post<FinanceBatchView>('/finance/batches', projectId ? { projectId } : {}));
export const useSendBatch = () =>
  useFinanceMutation(({ id, replay }: { id: ID; replay: boolean }) => apiClient.post<FinanceBatchView>(`/finance/batches/${id}/${replay ? 'replay' : 'send'}`));

export const downloadBatch = (id: ID) => apiClient.download(`/finance/batches/${id}/export`);
