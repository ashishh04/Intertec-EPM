import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';

import { AddCardDialog, AddColumnDialog, NewBoardDialog, RenameBoardDialog, boardKindLabel } from '@/components/board/BoardDialogs';
import { GridBoard } from '@/components/board/GridBoard';
import { KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { TaskStatusBoard } from '@/components/board/TaskStatusBoard';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBoard, useBoardMutations, useProjectBoards } from '@/hooks/useBoards';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import type { EpmBoardColumn, EpmBoardSummary, ID } from '@/types';

/** The board every project has without setting one up. */
const TASK_BOARD = 'tasks';

const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * A project's boards: the task board every project has, and the boards made
 * for it — basic lists, or columns by status, assignee, version, sub-project
 * or parent task. The chosen board is in the address (`?board=`), so it can
 * be shared and survives a reload.
 */
export function BoardWorkspace({ projectId }: { projectId: ID }) {
  const [params, setParams] = useSearchParams();
  const { canInProject } = useAuth();
  const boards = useProjectBoards(projectId);
  const mutations = useBoardMutations(projectId);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);

  const wanted = params.get('board') ?? TASK_BOARD;
  const current = boards.data?.find((board) => board.id === wanted);
  const mayCreate = canInProject(projectId, 'task:edit');

  const select = (id: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id === TASK_BOARD) next.delete('board');
        else next.set('board', id);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={current ? current.id : TASK_BOARD} onValueChange={select}>
          <SelectTrigger className="h-9 w-72" aria-label={t('Board')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TASK_BOARD}>{t('Task board')}</SelectItem>
            {(boards.data ?? []).length > 0 ? (
              <SelectGroup>
                <SelectLabel>{t('This project’s boards')}</SelectLabel>
                {(boards.data ?? []).map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
        {current ? (
          <Badge tone="neutral" size="sm">
            {boardKindLabel(current.kind)}
          </Badge>
        ) : (
          <span className="text-2xs text-muted-foreground">{t('Every task, by status')}</span>
        )}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {current?.canManage ? (
            <Button size="sm" variant="secondary" onClick={() => setAddingColumn(true)}>
              <Plus className="h-3.5 w-3.5" />
              {current.kind === 'basic' ? t('Add a list') : t('Add a column')}
            </Button>
          ) : null}
          {current?.canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('Board actions')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('Rename')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-danger" onSelect={() => setDeleting(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('Delete the board')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {mayCreate ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('New board')}
            </Button>
          ) : null}
        </div>
      </div>

      {current ? <GridBoardView key={current.id} board={current} projectId={projectId} /> : <TaskStatusBoard projectId={projectId} />}

      <NewBoardDialog
        open={creating}
        onOpenChange={setCreating}
        pending={mutations.create.isPending}
        onCreate={(input) =>
          mutations.create.mutateAsync(input).then((board) => {
            toast.success(t('Board created'));
            setCreating(false);
            select(board.id);
          })
        }
      />
      <RenameBoardDialog
        open={renaming}
        onOpenChange={setRenaming}
        board={current}
        pending={mutations.rename.isPending}
        onRename={(name) =>
          mutations.rename.mutateAsync({ id: current!.id, name }).then(() => {
            toast.success(t('Board renamed'));
            setRenaming(false);
          })
        }
      />
      <AddColumnDialog
        open={addingColumn}
        onOpenChange={setAddingColumn}
        board={current}
        pending={mutations.addColumn.isPending}
        onAdd={(input) =>
          mutations.addColumn.mutateAsync({ id: current!.id, input }).then(() => {
            toast.success(current?.kind === 'basic' ? t('List added') : t('Column added'));
            setAddingColumn(false);
          })
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('Delete {name}?', { name: current?.name ?? '' })}
        description={t('The board and its columns go. The tasks on it are not touched.')}
        confirmLabel={t('Delete the board')}
        tone="danger"
        pending={mutations.remove.isPending}
        onConfirm={() =>
          mutations.remove.mutate(current!.id, {
            onSuccess: () => {
              toast.success(t('Board deleted'));
              setDeleting(false);
              select(TASK_BOARD);
            },
            onError: (error) => toast.error(t('That could not be deleted'), { description: errorText(error) }),
          })
        }
      />
    </div>
  );
}

/** One made board: its columns and cards, moved by dragging. */
function GridBoardView({ board, projectId }: { board: EpmBoardSummary; projectId: ID }) {
  const { openTaskDrawer } = useUI();
  const users = useUserMap();
  const detail = useBoard(board.id);
  const mutations = useBoardMutations(projectId);
  const [addingTo, setAddingTo] = useState<EpmBoardColumn>();
  const [removing, setRemoving] = useState<EpmBoardColumn>();

  /** A column's add button: a task put on the list, or a new one with the column's value. */
  const addCard = (column: EpmBoardColumn) => {
    switch (board.kind) {
      case 'basic':
        return setAddingTo(column);
      case 'status':
        return openTaskDrawer({ projectId, statusId: column.value });
      case 'assignee':
        return openTaskDrawer({ projectId, assigneeId: column.value });
      case 'version':
        return openTaskDrawer({ projectId, sprintId: column.value });
      case 'subproject':
        return openTaskDrawer({ projectId: column.value ?? projectId });
      case 'subtasks':
        return openTaskDrawer({ projectId, parentId: column.value });
    }
  };

  return (
    <QueryBoundary
      isLoading={detail.isLoading}
      isError={detail.isError}
      error={detail.error}
      onRetry={() => detail.refetch()}
      errorTitle={t('Unable to load the board')}
      skeleton={<KanbanBoardSkeleton columns={Math.max(1, Math.min(board.columnCount, 5))} />}
      isEmpty={(detail.data?.columns.length ?? 0) === 0}
      empty={
        <Card>
          <EmptyState
            title={t('No columns yet')}
            description={
              board.canManage
                ? board.kind === 'basic'
                  ? t('Add a list, then put tasks on it.')
                  : t('Add a column for each value you want to see, then drag cards between them.')
                : t('Whoever manages this board has not given it columns yet.')
            }
          />
        </Card>
      }
    >
      {detail.data ? (
        <GridBoard
          board={detail.data}
          users={users}
          onMove={(input) =>
            mutations.move.mutateAsync({ id: board.id, input }).catch((error) => {
              toast.error(t('Unable to move the task'), { description: errorText(error) });
              throw error;
            })
          }
          onAddCard={addCard}
          onRemoveColumn={setRemoving}
          onRemoveCard={
            board.kind === 'basic'
              ? (column, task) =>
                  mutations.removeCard.mutate(
                    { id: board.id, queryId: column.queryId, workPackageId: task.id },
                    { onError: (error) => toast.error(t('That could not be changed'), { description: errorText(error) }) },
                  )
              : undefined
          }
        />
      ) : null}

      <AddCardDialog
        open={Boolean(addingTo)}
        onOpenChange={(open) => !open && setAddingTo(undefined)}
        projectId={projectId}
        column={addingTo}
        pending={mutations.move.isPending}
        onAdd={(task) =>
          mutations.move
            .mutateAsync({ id: board.id, input: { workPackageId: task.id, toQueryId: addingTo!.queryId, position: addingTo!.cards.length } })
            .then(() => toast.success(t('{key} added to {list}', { key: task.key, list: addingTo?.name ?? '' })))
        }
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('Remove the {name} column?', { name: removing?.name ?? '' })}
        description={t('The tasks in it stay as they are; only the column goes.')}
        confirmLabel={t('Remove the column')}
        tone="danger"
        pending={mutations.removeColumn.isPending}
        onConfirm={() =>
          mutations.removeColumn.mutate(
            { id: board.id, queryId: removing!.queryId },
            {
              onSuccess: () => {
                toast.success(t('Column removed'));
                setRemoving(undefined);
              },
              onError: (error) => toast.error(t('That could not be changed'), { description: errorText(error) }),
            },
          )
        }
      />
    </QueryBoundary>
  );
}
