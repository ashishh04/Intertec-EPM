import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { approvalService } from '@/services';
import type { ApprovalDecision } from '@/services/api/approvals';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { ApprovalChainInput, ApprovalDelegationInput, ID } from '@/types';

/**
 * A decision, a submission or a withdrawal moves the request, the subject's
 * status, the inbox and the badge, and writes notifications: all of them are
 * refreshed together, with the project reads a status change touches.
 */
function refreshAfterDecision(client: QueryClient) {
  void client.invalidateQueries({ queryKey: ['approvals'] });
  void client.invalidateQueries({ queryKey: ['tasks'] });
  void client.invalidateQueries({ queryKey: ['notifications'] });
  for (const key of invalidationGroups.projectWrite) void client.invalidateQueries({ queryKey: key });
}

export function useApprovalChains(enabled = true) {
  return useQuery({ queryKey: queryKeys.approvalChains(), queryFn: () => approvalService.getChains(), enabled });
}

export function useApprovalOptions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.approvalOptions(),
    queryFn: () => approvalService.getOptions(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveApprovalChain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: ApprovalChainInput }) =>
      id ? approvalService.updateChain(id, input) : approvalService.createChain(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

export function useDeleteApprovalChain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => approvalService.deleteChain(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.approvalChains() }),
  });
}

/** The approval state of one work package. */
export function useApprovalSubject(workPackageId?: ID) {
  return useQuery({
    queryKey: queryKeys.approvalSubject(workPackageId ?? 'unknown'),
    queryFn: () => approvalService.getSubject(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 15_000,
  });
}

export function useSubmitForApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workPackageId: ID) => approvalService.submit(workPackageId),
    onSuccess: (state, workPackageId) => {
      client.setQueryData(queryKeys.approvalSubject(workPackageId), state);
      refreshAfterDecision(client);
    },
  });
}

export function useApprovalInbox() {
  return useQuery({ queryKey: queryKeys.approvalInbox(), queryFn: () => approvalService.getInbox(), staleTime: 15_000 });
}

/** How many approvals wait on the signed-in person, for the navigation badge. */
export function useApprovalInboxCount(): number {
  const { data } = useQuery({
    queryKey: queryKeys.approvalInboxCount(),
    queryFn: () => approvalService.getInboxCount(),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  return data?.count ?? 0;
}

export function useApprovalRequests(scope: 'mine' | 'projects', status?: string) {
  return useQuery({
    queryKey: queryKeys.approvalRequests(scope, status),
    queryFn: () => approvalService.getRequests(scope, status),
    staleTime: 15_000,
  });
}

export function useApprovalJournal(requestId?: ID) {
  return useQuery({
    queryKey: queryKeys.approvalJournal(requestId ?? 'unknown'),
    queryFn: () => approvalService.getJournal(requestId!),
    enabled: Boolean(requestId),
  });
}

export function useDecideApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, decision, comment }: { taskId: ID; decision: ApprovalDecision; comment?: string }) =>
      approvalService.decide(taskId, decision, comment),
    onSuccess: () => refreshAfterDecision(client),
  });
}

export function useCancelApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, reason }: { requestId: ID; reason?: string }) => approvalService.cancel(requestId, reason),
    onSuccess: () => refreshAfterDecision(client),
  });
}

export function useApprovalLink(token?: string) {
  return useQuery({
    queryKey: queryKeys.approvalLink(token ?? 'none'),
    queryFn: () => approvalService.getLink(token!),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useDecideApprovalLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ token, decision, comment }: { token: string; decision: ApprovalDecision; comment?: string }) =>
      approvalService.decideLink(token, decision, comment),
    onSuccess: () => refreshAfterDecision(client),
  });
}

export function useApprovalDelegations(all = false) {
  return useQuery({
    queryKey: queryKeys.approvalDelegations(all),
    queryFn: () => approvalService.getDelegations(all),
  });
}

export function useCreateDelegation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ApprovalDelegationInput) => approvalService.createDelegation(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

export function useRevokeDelegation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => approvalService.revokeDelegation(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['approvals'] }),
  });
}
