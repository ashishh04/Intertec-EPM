import { apiClient } from './client';
import { env } from '@/config/env';
import { intlLocale, t } from '@/lib/i18n';
import type { ExpenseCategory, ExpenseClaimInput, ExpenseClaimStatus, ExpenseClaimView, ExpenseReceiptView, ID } from '@/types';

/**
 * Expense claims (Module 10: BR-307 to BR-309).
 *
 * Anyone claims a cost on a project they belong to; the approvers a claim's
 * chain names read it while it is theirs to decide; `expenses:manage` reads
 * every claim and exports a period for finance. Categories are OpenProject's
 * cost types.
 */

export interface ClaimListQuery {
  scope?: 'mine' | 'all';
  status?: ExpenseClaimStatus;
  projectId?: ID;
  from?: string;
  to?: string;
}

export class ApiExpenseRepository {
  categories(): Promise<ExpenseCategory[]> {
    return apiClient.get<ExpenseCategory[]>('/expenses/categories');
  }

  createCategory(name: string): Promise<ExpenseCategory> {
    return apiClient.post<ExpenseCategory>('/expenses/categories', { name });
  }

  list(query: ClaimListQuery = {}): Promise<ExpenseClaimView[]> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) if (value) params[key] = String(value);
    return apiClient.get<ExpenseClaimView[]>('/expenses', params);
  }

  get(id: ID): Promise<ExpenseClaimView> {
    return apiClient.get<ExpenseClaimView>(`/expenses/${id}`);
  }

  create(input: ExpenseClaimInput): Promise<ExpenseClaimView> {
    return apiClient.post<ExpenseClaimView>('/expenses', input);
  }

  update(id: ID, input: ExpenseClaimInput): Promise<ExpenseClaimView> {
    return apiClient.patch<ExpenseClaimView>(`/expenses/${id}`, input);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/expenses/${id}`);
  }

  submit(id: ID): Promise<ExpenseClaimView> {
    return apiClient.post<ExpenseClaimView>(`/expenses/${id}/submit`);
  }

  withdraw(id: ID): Promise<ExpenseClaimView> {
    return apiClient.post<ExpenseClaimView>(`/expenses/${id}/withdraw`);
  }

  post(id: ID): Promise<ExpenseClaimView> {
    return apiClient.post<ExpenseClaimView>(`/expenses/${id}/post`);
  }

  /** Uploads one receipt, as the browser's own File (see the attachments service). */
  async addReceipt(id: ID, file: File): Promise<ExpenseReceiptView> {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await fetch(`${env.apiBaseUrl}/expenses/${id}/receipts`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Accept-Language': intlLocale() },
      body,
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(failure.message ?? t('The upload failed.'));
    }
    return (await response.json()) as ExpenseReceiptView;
  }

  removeReceipt(id: ID, receiptId: ID): Promise<void> {
    return apiClient.delete<void>(`/expenses/${id}/receipts/${receiptId}`);
  }

  /** Where the browser downloads a receipt: an EPM address, with the session's own access. */
  receiptUrl(id: ID, receiptId: ID): string {
    return `${env.apiBaseUrl}/expenses/${id}/receipts/${receiptId}`;
  }

  /** The finance export for a period, as a workbook (BR-309). */
  exportPeriod(from: string, to: string): Promise<Blob> {
    return apiClient.download('/expenses/export', { from, to });
  }
}
