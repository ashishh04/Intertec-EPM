import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { expenseService, timesheetService } from '@/services';
import type { ClaimListQuery } from '@/services/api/expenses';
import type { TimesheetOverviewQuery } from '@/services/api/timesheets';
import type { ExpenseClaimInput, ID, TimeSettings } from '@/types';

/**
 * Timesheets, the time rules and expense claims (Module 10). A timesheet's
 * state locks or unlocks time entries, and a claim posted becomes project cost,
 * so writes here refresh time entries and the cost figures too.
 */

export const timeKeys = {
  settings: () => ['time', 'settings'] as const,
  timesheets: ['timesheets'] as const,
  mine: (day?: string) => ['timesheets', 'mine', day ?? ''] as const,
  history: () => ['timesheets', 'history'] as const,
  person: (personId: ID, day?: string) => ['timesheets', 'person', personId, day ?? ''] as const,
  one: (id: ID) => ['timesheets', 'one', id] as const,
  overview: (query: TimesheetOverviewQuery) => ['timesheets', 'overview', query] as const,
  expenses: ['expenses'] as const,
  categories: () => ['expenses', 'categories'] as const,
  claims: (query: ClaimListQuery) => ['expenses', 'list', query] as const,
  claim: (id: ID) => ['expenses', 'one', id] as const,
};

function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: timeKeys.timesheets });
    void client.invalidateQueries({ queryKey: timeKeys.expenses });
    void client.invalidateQueries({ queryKey: ['time-entries'] });
    void client.invalidateQueries({ queryKey: ['approvals'] });
    void client.invalidateQueries({ queryKey: ['insights'] });
  };
}

/* ---------------------------------------------------------------- settings */

export function useTimeSettings(enabled = true) {
  return useQuery({ queryKey: timeKeys.settings(), queryFn: () => timesheetService.getSettings(), enabled, staleTime: 60_000 });
}

export function useSaveTimeSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: Pick<TimeSettings, 'timesheets' | 'policies' | 'expenses'>) => timesheetService.saveSettings(settings),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: timeKeys.settings() });
      void client.invalidateQueries({ queryKey: timeKeys.timesheets });
    },
  });
}

/* -------------------------------------------------------------- timesheets */

export function useMyTimesheet(day?: string) {
  return useQuery({ queryKey: timeKeys.mine(day), queryFn: () => timesheetService.mine(day) });
}

export function useTimesheetHistory() {
  return useQuery({ queryKey: timeKeys.history(), queryFn: () => timesheetService.history() });
}

export function usePersonTimesheet(personId: ID | undefined, day?: string) {
  return useQuery({
    queryKey: timeKeys.person(personId ?? '', day),
    queryFn: () => timesheetService.ofPerson(personId!, day),
    enabled: Boolean(personId),
  });
}

export function useTimesheet(id: ID | undefined) {
  return useQuery({ queryKey: timeKeys.one(id ?? ''), queryFn: () => timesheetService.get(id!), enabled: Boolean(id) });
}

export function useTimesheetOverview(query: TimesheetOverviewQuery, enabled = true) {
  return useQuery({ queryKey: timeKeys.overview(query), queryFn: () => timesheetService.overview(query), enabled, retry: false });
}

export function useSubmitTimesheet() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (day: string) => timesheetService.submit(day), onSuccess: refresh });
}

export function useWithdrawTimesheet() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: ID) => timesheetService.withdraw(id), onSuccess: refresh });
}

export function useReopenTimesheet() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, reason }: { id: ID; reason: string }) => timesheetService.reopen(id, reason), onSuccess: refresh });
}

/* ---------------------------------------------------------------- expenses */

export function useExpenseCategories() {
  return useQuery({ queryKey: timeKeys.categories(), queryFn: () => expenseService.categories(), staleTime: 60_000 });
}

export function useCreateExpenseCategory() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (name: string) => expenseService.createCategory(name), onSuccess: refresh });
}

export function useClaims(query: ClaimListQuery, enabled = true) {
  return useQuery({ queryKey: timeKeys.claims(query), queryFn: () => expenseService.list(query), enabled });
}

export function useClaim(id: ID | undefined) {
  return useQuery({ queryKey: timeKeys.claim(id ?? ''), queryFn: () => expenseService.get(id!), enabled: Boolean(id) });
}

export function useCreateClaim() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (input: ExpenseClaimInput) => expenseService.create(input), onSuccess: refresh });
}

export function useUpdateClaim() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: ExpenseClaimInput }) => expenseService.update(id, input),
    onSuccess: refresh,
  });
}

export function useDeleteClaim() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: ID) => expenseService.remove(id), onSuccess: refresh });
}

export function useClaimAction(action: 'submit' | 'withdraw' | 'post') {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: ID) => expenseService[action](id), onSuccess: refresh });
}

export function useAddReceipt() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, file }: { id: ID; file: File }) => expenseService.addReceipt(id, file), onSuccess: refresh });
}

export function useRemoveReceipt() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, receiptId }: { id: ID; receiptId: ID }) => expenseService.removeReceipt(id, receiptId),
    onSuccess: refresh,
  });
}
