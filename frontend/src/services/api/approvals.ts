import { apiClient } from './client';
import type {
  ApprovalChain,
  ApprovalChainInput,
  ApprovalChainOptions,
  ApprovalDelegation,
  ApprovalDelegationInput,
  ApprovalLinkView,
  ApprovalRequestView,
  ApprovalSubjectState,
  AuditEvent,
  ID,
} from '@/types';

export type ApprovalDecision = 'approve' | 'reject';

/**
 * Approvals (BRQ-09). EPM-owned, so outside the OpenProject-backed repository
 * contract, like teams and the health rules.
 */
export class ApiApprovalRepository {
  /* chains — approvals:configure */
  getChains(): Promise<ApprovalChain[]> {
    return apiClient.get<ApprovalChain[]>('/approvals/chains');
  }

  getOptions(): Promise<ApprovalChainOptions> {
    return apiClient.get<ApprovalChainOptions>('/approvals/options');
  }

  createChain(input: ApprovalChainInput): Promise<ApprovalChain> {
    return apiClient.post<ApprovalChain>('/approvals/chains', input);
  }

  updateChain(id: ID, input: ApprovalChainInput): Promise<ApprovalChain> {
    return apiClient.patch<ApprovalChain>(`/approvals/chains/${id}`, input);
  }

  deleteChain(id: ID): Promise<void> {
    return apiClient.delete<void>(`/approvals/chains/${id}`);
  }

  /* a work package's approval */
  getSubject(workPackageId: ID): Promise<ApprovalSubjectState> {
    return apiClient.get<ApprovalSubjectState>(`/approvals/subjects/work-packages/${workPackageId}`);
  }

  submit(workPackageId: ID): Promise<ApprovalSubjectState> {
    return apiClient.post<ApprovalSubjectState>(`/approvals/subjects/work-packages/${workPackageId}/submit`);
  }

  /* requests */
  getInbox(): Promise<ApprovalRequestView[]> {
    return apiClient.get<ApprovalRequestView[]>('/approvals/inbox');
  }

  getInboxCount(): Promise<{ count: number }> {
    return apiClient.get<{ count: number }>('/approvals/inbox/count');
  }

  getRequests(scope: 'mine' | 'projects', status?: string): Promise<ApprovalRequestView[]> {
    return apiClient.get<ApprovalRequestView[]>('/approvals/requests', { scope, status });
  }

  getJournal(requestId: ID): Promise<AuditEvent[]> {
    return apiClient.get<AuditEvent[]>(`/approvals/requests/${requestId}/journal`);
  }

  decide(taskId: ID, decision: ApprovalDecision, comment?: string): Promise<ApprovalRequestView> {
    return apiClient.post<ApprovalRequestView>(`/approvals/tasks/${taskId}/decide`, { decision, comment });
  }

  cancel(requestId: ID, reason?: string): Promise<ApprovalRequestView> {
    return apiClient.post<ApprovalRequestView>(`/approvals/requests/${requestId}/cancel`, { reason });
  }

  /* email links */
  getLink(token: string): Promise<ApprovalLinkView> {
    return apiClient.get<ApprovalLinkView>(`/approvals/links/${encodeURIComponent(token)}`);
  }

  decideLink(token: string, decision: ApprovalDecision, comment?: string): Promise<ApprovalRequestView> {
    return apiClient.post<ApprovalRequestView>(`/approvals/links/${encodeURIComponent(token)}/decide`, { decision, comment });
  }

  /* delegations */
  getDelegations(all = false): Promise<ApprovalDelegation[]> {
    return apiClient.get<ApprovalDelegation[]>('/approvals/delegations', { all: all ? 'true' : undefined });
  }

  createDelegation(input: ApprovalDelegationInput): Promise<ApprovalDelegation> {
    return apiClient.post<ApprovalDelegation>('/approvals/delegations', input);
  }

  revokeDelegation(id: ID): Promise<ApprovalDelegation> {
    return apiClient.post<ApprovalDelegation>(`/approvals/delegations/${id}/revoke`);
  }
}
