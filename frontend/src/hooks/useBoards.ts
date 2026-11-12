import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidationGroups } from '@/lib/queryKeys';
import { backlogService, boardService } from '@/services/api/boards';
import type { BacklogMoveInput, BoardInput, BoardMoveInput, ID, ImpedimentInput } from '@/types';

/** Boards, the backlog and impediments. */

export function useProjectBoards(projectId?: ID) {
  return useQuery({
    queryKey: ['boards', 'list', projectId ?? 'unknown'],
    queryFn: () => boardService.list(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

export function useBoard(id?: ID) {
  return useQuery({
    queryKey: ['boards', 'detail', id ?? 'unknown'],
    queryFn: () => boardService.get(id!),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useBoardColumnOptions(id: ID | undefined, search: string, enabled: boolean) {
  return useQuery({
    queryKey: ['boards', 'column-options', id ?? 'unknown', search],
    queryFn: () => boardService.columnOptions(id!, search),
    enabled: Boolean(id) && enabled,
    staleTime: 15_000,
  });
}

/** Every change to a board, and the task writes a move makes. */
export function useBoardMutations(projectId?: ID) {
  const client = useQueryClient();
  const boards = () => void client.invalidateQueries({ queryKey: ['boards'] });
  const tasks = () => {
    boards();
    for (const key of invalidationGroups.taskWrite) void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['sprints'] });
  };
  return {
    create: useMutation({ mutationFn: (input: BoardInput) => boardService.create(projectId!, input), onSuccess: boards }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: ID; name: string }) => boardService.rename(id, name), onSuccess: boards }),
    remove: useMutation({ mutationFn: (id: ID) => boardService.remove(id), onSuccess: boards }),
    addColumn: useMutation({
      mutationFn: ({ id, input }: { id: ID; input: { name?: string; value?: ID } }) => boardService.addColumn(id, input),
      onSuccess: boards,
    }),
    removeColumn: useMutation({ mutationFn: ({ id, queryId }: { id: ID; queryId: ID }) => boardService.removeColumn(id, queryId), onSuccess: boards }),
    orderColumns: useMutation({ mutationFn: ({ id, queryIds }: { id: ID; queryIds: ID[] }) => boardService.orderColumns(id, queryIds), onSuccess: boards }),
    move: useMutation({ mutationFn: ({ id, input }: { id: ID; input: BoardMoveInput }) => boardService.move(id, input), onSettled: tasks }),
    removeCard: useMutation({
      mutationFn: ({ id, queryId, workPackageId }: { id: ID; queryId: ID; workPackageId: ID }) => boardService.removeCard(id, queryId, workPackageId),
      onSuccess: boards,
    }),
  };
}

export function useBacklog(projectId?: ID) {
  return useQuery({
    queryKey: ['backlog', projectId ?? 'unknown'],
    queryFn: () => backlogService.get(projectId!),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useBacklogMove(projectId: ID) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BacklogMoveInput) => backlogService.move(projectId, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['backlog', projectId] });
      void client.invalidateQueries({ queryKey: ['sprints'] });
      for (const key of invalidationGroups.taskWrite) void client.invalidateQueries({ queryKey: key });
    },
  });
}

export function useImpediments(sprintId?: ID, projectId?: ID) {
  return useQuery({
    queryKey: ['impediments', sprintId ?? 'none', projectId ?? 'all'],
    queryFn: () => backlogService.impediments(sprintId!, projectId),
    enabled: Boolean(sprintId),
    staleTime: 15_000,
  });
}

export function useRaiseImpediment(sprintId?: ID) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ImpedimentInput & { projectId: ID }) => backlogService.raiseImpediment(sprintId!, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['impediments'] });
      void client.invalidateQueries({ queryKey: ['backlog'] });
      for (const key of invalidationGroups.taskWrite) void client.invalidateQueries({ queryKey: key });
    },
  });
}
