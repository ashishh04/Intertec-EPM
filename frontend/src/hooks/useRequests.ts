import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidationGroups } from '@/lib/queryKeys';
import { projectRequestService, stageGateService } from '@/services/api/requests';
import type { ID, ProjectRequestInput } from '@/types';

/** Project requests and stage gate reviews. */

export function useProjectRequests(scope: 'mine' | 'all') {
  return useQuery({ queryKey: ['project-requests', 'list', scope], queryFn: () => projectRequestService.list(scope), staleTime: 15_000 });
}

export function useProjectRequest(id?: ID) {
  return useQuery({
    queryKey: ['project-requests', 'detail', id ?? 'unknown'],
    queryFn: () => projectRequestService.get(id!),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useProjectRequestMutations() {
  const client = useQueryClient();
  const settle = () => {
    void client.invalidateQueries({ queryKey: ['project-requests'] });
    void client.invalidateQueries({ queryKey: ['approvals'] });
  };
  const created = () => {
    settle();
    for (const key of invalidationGroups.projectWrite) void client.invalidateQueries({ queryKey: key });
  };
  return {
    create: useMutation({ mutationFn: (input: ProjectRequestInput) => projectRequestService.create(input), onSuccess: settle }),
    update: useMutation({ mutationFn: ({ id, input }: { id: ID; input: ProjectRequestInput }) => projectRequestService.update(id, input), onSuccess: settle }),
    remove: useMutation({ mutationFn: (id: ID) => projectRequestService.remove(id), onSuccess: settle }),
    submit: useMutation({ mutationFn: (id: ID) => projectRequestService.submit(id), onSuccess: settle }),
    withdraw: useMutation({ mutationFn: (id: ID) => projectRequestService.withdraw(id), onSuccess: settle }),
    createProject: useMutation({ mutationFn: (id: ID) => projectRequestService.createProject(id), onSuccess: created }),
    link: useMutation({ mutationFn: ({ id, projectId }: { id: ID; projectId: ID }) => projectRequestService.link(id, projectId), onSuccess: created }),
  };
}

export function useProjectGates(projectId?: ID) {
  return useQuery({
    queryKey: ['stage-gates', 'project', projectId ?? 'unknown'],
    queryFn: () => stageGateService.gates(projectId!),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useStageGateReview(id?: ID) {
  return useQuery({
    queryKey: ['stage-gates', 'review', id ?? 'unknown'],
    queryFn: () => stageGateService.get(id!),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useStageGateMutations() {
  const client = useQueryClient();
  const settle = () => {
    void client.invalidateQueries({ queryKey: ['stage-gates'] });
    void client.invalidateQueries({ queryKey: ['approvals'] });
    void client.invalidateQueries({ queryKey: ['activity'] });
  };
  return {
    request: useMutation({
      mutationFn: ({ projectId, definitionId, gate, notes }: { projectId: ID; definitionId: ID; gate: 'start' | 'finish'; notes?: string }) =>
        stageGateService.request(projectId, definitionId, gate, notes),
      onSuccess: settle,
    }),
    withdraw: useMutation({ mutationFn: (id: ID) => stageGateService.withdraw(id), onSuccess: settle }),
  };
}
