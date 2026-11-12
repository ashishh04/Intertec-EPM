import { useEffect, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MoreHorizontal, Plus, Trash2, X } from 'lucide-react';

import { KanbanCard } from '@/components/board/KanbanBoard';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/lib/i18n';
import { cn, formatNumber } from '@/lib/utils';
import type { BoardMoveInput, EpmBoard, EpmBoardColumn, EpmTask, EpmUser, ID } from '@/types';

/** Two parts, so the same task can sit in two lists of a basic board. */
const cardKey = (queryId: ID, taskId: ID) => `${queryId}::${taskId}`;
const COLUMN_PREFIX = 'column::';

interface GridBoardProps {
  board: EpmBoard;
  users: Map<ID, EpmUser>;
  /** Moves a card; the board goes back to what it was if this fails. */
  onMove: (input: BoardMoveInput) => Promise<unknown>;
  /** The column header's add button: a new task there, or one put on a list. */
  onAddCard?: (column: EpmBoardColumn) => void;
  onRemoveColumn?: (column: EpmBoardColumn) => void;
  /** A basic board's lists only: takes the card off the list. */
  onRemoveCard?: (column: EpmBoardColumn, task: EpmTask) => void;
}

/**
 * A board's columns side by side, its cards dragged between them and within
 * one. The move shows at once and is undone if the server refuses it — a
 * status the workflow does not allow, say, or a version the task cannot take.
 */
export function GridBoard({ board, users, onMove, onAddCard, onRemoveColumn, onRemoveCard }: GridBoardProps) {
  const [columns, setColumns] = useState(board.columns);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => setColumns(board.columns), [board.columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const parse = (key: string) => {
    const [queryId, taskId] = key.split('::');
    return { queryId: queryId!, taskId: taskId! };
  };
  const active = activeKey ? parse(activeKey) : null;
  const activeTask = active ? columns.find((column) => column.queryId === active.queryId)?.cards.find((card) => card.id === active.taskId) : undefined;

  const handleDragStart = (event: DragStartEvent) => setActiveKey(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveKey(null);
    const { over } = event;
    if (!over) return;
    const from = parse(String(event.active.id));
    const source = columns.find((column) => column.queryId === from.queryId);
    const task = source?.cards.find((card) => card.id === from.taskId);
    if (!source || !task) return;

    const overKey = String(over.id);
    let toQueryId: ID;
    let index: number;
    if (overKey.startsWith(COLUMN_PREFIX)) {
      toQueryId = overKey.slice(COLUMN_PREFIX.length);
      const target = columns.find((column) => column.queryId === toQueryId);
      index = (target?.cards ?? []).filter((card) => card.id !== task.id).length;
    } else {
      const to = parse(overKey);
      toQueryId = to.queryId;
      const target = columns.find((column) => column.queryId === toQueryId);
      const at = (target?.cards ?? []).findIndex((card) => card.id === to.taskId);
      index = at < 0 ? (target?.cards.length ?? 0) : at;
    }

    if (toQueryId === from.queryId) {
      const oldIndex = source.cards.findIndex((card) => card.id === task.id);
      if (oldIndex === index) return;
      setColumns((current) =>
        current.map((column) => (column.queryId === from.queryId ? { ...column, cards: arrayMove(column.cards, oldIndex, index) } : column)),
      );
    } else {
      setColumns((current) =>
        current.map((column) => {
          if (column.queryId === from.queryId) {
            return { ...column, cards: column.cards.filter((card) => card.id !== task.id), total: Math.max(0, column.total - 1) };
          }
          if (column.queryId === toQueryId) {
            const already = column.cards.some((card) => card.id === task.id);
            const cards = column.cards.filter((card) => card.id !== task.id);
            cards.splice(Math.min(index, cards.length), 0, task);
            return { ...column, cards, total: already ? column.total : column.total + 1 };
          }
          return column;
        }),
      );
    }
    onMove({ workPackageId: task.id, fromQueryId: from.queryId, toQueryId, position: index }).catch(() => setColumns(board.columns));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveKey(null)}
    >
      {/* Bounded, so the columns scroll inside themselves rather than growing the page. */}
      <div className="epm-scroll flex max-h-[calc(100dvh-19rem)] min-h-72 items-stretch gap-3 overflow-x-auto pb-2">
        {columns.map((column) => (
          <BoardColumn
            key={column.queryId}
            column={column}
            users={users}
            canManage={board.canManage}
            onAddCard={onAddCard}
            onRemoveColumn={onRemoveColumn}
            onRemoveCard={onRemoveCard}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }}>
        {activeTask ? (
          <KanbanCard task={activeTask} assignee={activeTask.assigneeId ? users.get(activeTask.assigneeId) : undefined} dragging />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  column,
  users,
  canManage,
  onAddCard,
  onRemoveColumn,
  onRemoveCard,
}: {
  column: EpmBoardColumn;
  users: Map<ID, EpmUser>;
  canManage: boolean;
  onAddCard?: (column: EpmBoardColumn) => void;
  onRemoveColumn?: (column: EpmBoardColumn) => void;
  onRemoveCard?: (column: EpmBoardColumn, task: EpmTask) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${column.queryId}` });
  const keys = column.cards.map((card) => cardKey(column.queryId, card.id));

  return (
    <Card
      role="region"
      className="flex w-72 shrink-0 flex-col bg-surface-sunken/60 shadow-none"
      aria-label={t('{status} column, {count, plural, one {# task} other {# tasks}}', { status: column.name, count: column.total })}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-xs font-semibold tracking-tight" dir="auto" title={column.name}>
            {column.name}
          </h3>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">{formatNumber(column.total)}</span>
        </div>
        <div className="flex shrink-0 items-center">
          {onAddCard ? (
            <Button variant="ghost" size="icon-sm" onClick={() => onAddCard(column)} aria-label={t('Add a task to {status}', { status: column.name })}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {canManage && onRemoveColumn ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('{name} column actions', { name: column.name })}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="text-danger" onSelect={() => onRemoveColumn(column)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('Remove the column')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'epm-scroll relative flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-b-xl px-2 pb-2 transition-colors',
          isOver && 'bg-primary-soft/60 ring-1 ring-inset ring-primary/30',
        )}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          {column.cards.map((card) => (
            <SortableCard
              key={card.id}
              id={cardKey(column.queryId, card.id)}
              task={card}
              assignee={card.assigneeId ? users.get(card.assigneeId) : undefined}
              onRemove={canManage && onRemoveCard ? () => onRemoveCard(column, card) : undefined}
            />
          ))}
        </SortableContext>
        {column.cards.length === 0 ? (
          <EmptyState size="inline" title={isOver ? t('Drop here') : t('Nothing here')} className="py-6" />
        ) : null}
        {column.total > column.cards.length ? (
          <p className="px-1 text-2xs text-muted-foreground">
            {t('Showing {shown, number} of {total, number}', { shown: column.cards.length, total: column.total })}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function SortableCard({ id, task, assignee, onRemove }: { id: string; task: EpmTask; assignee?: EpmUser; onRemove?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group relative', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <KanbanCard task={task} assignee={assignee} />
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute end-1 top-8 h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={t('Take {key} off this list', { key: task.key })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
