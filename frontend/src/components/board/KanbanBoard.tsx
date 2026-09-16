import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { CalendarClock, Plus } from 'lucide-react';
import { TASK_STATUS_META, TASK_STATUS_ORDER, TONE_FILL } from '@/lib/domain';
import { cn, describeDueDate, formatNumber, pluralize } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { PriorityBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import type { ID, EpmTask, EpmUser, TaskStatusCategory } from '@/types';

/** Cards rendered per column before the reader has to ask for more. */
const COLUMN_PAGE_SIZE = 15;

interface KanbanBoardProps {
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  onStatusChange: (taskId: ID, status: TaskStatusCategory) => void;
  onCreate?: (status: TaskStatusCategory) => void;
  /** Column set. Defaults to the standard delivery flow. */
  columns?: TaskStatusCategory[];
  className?: string;
}

/**
 * Delivery board with drag-and-drop between columns.
 *
 * Cards are also movable from the keyboard: focus a card and use the status
 * menu in the task detail page, so the board never becomes pointer-only.
 */
export function KanbanBoard({
  tasks,
  users,
  onStatusChange,
  onCreate,
  columns = TASK_STATUS_ORDER,
  className,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<ID | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const grouped = useMemo(() => {
    const map = new Map<TaskStatusCategory, EpmTask[]>();
    for (const status of columns) map.set(status, []);
    for (const task of tasks) {
      if (!map.has(task.statusCategory)) continue;
      map.get(task.statusCategory)!.push(task);
    }
    return map;
  }, [tasks, columns]);

  const activeTask = activeId ? tasks.find((task) => task.id === activeId) : null;

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as ID);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const nextStatus = over.id as TaskStatusCategory;
    const task = tasks.find((item) => item.id === active.id);
    if (!task || task.statusCategory === nextStatus) return;
    onStatusChange(task.id, nextStatus);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {/* Bounded, so the columns scroll inside themselves rather than growing
          the page. Without this a busy column pushes everything below the board
          — including its own "show more" and the board's summary — off screen. */}
      <div
        className={cn(
          'epm-scroll flex max-h-[calc(100dvh-19rem)] min-h-72 items-stretch gap-3 overflow-x-auto pb-2',
          className,
        )}
      >
        {columns.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={grouped.get(status) ?? []}
            users={users}
            onCreate={onCreate}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }}>
        {activeTask ? (
          <KanbanCard
            task={activeTask}
            assignee={activeTask.assigneeId ? users.get(activeTask.assigneeId) : undefined}
            dragging
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function KanbanColumn({
  status,
  tasks,
  users,
  onCreate,
}: {
  status: TaskStatusCategory;
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  onCreate?: (status: TaskStatusCategory) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = TASK_STATUS_META[status];

  // A busy column would otherwise grow without limit; cards load in batches.
  const [visibleCount, setVisibleCount] = useState(COLUMN_PAGE_SIZE);
  const visible = tasks.slice(0, visibleCount);
  const remaining = tasks.length - visible.length;

  return (
    // A named region, which is what the <section aria-label> it replaces was.
    <Card
      role="region"
      className="flex w-72 shrink-0 flex-col bg-surface-sunken/60 shadow-none"
      aria-label={`${meta.label} column, ${formatNumber(tasks.length)} ${pluralize(tasks.length, 'task')}`}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', TONE_FILL[meta.tone])} aria-hidden />
          {/* CardTitle scaled down one step: the column is a card, but a board
              of seven of them needs a quieter heading than a page card. */}
          <h3 className="text-xs font-semibold tracking-tight">{meta.label}</h3>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {formatNumber(tasks.length)}
          </span>
        </div>
        {onCreate ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onCreate(status)}
            aria-label={`Add a task to ${meta.label}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'epm-scroll relative flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-b-xl px-2 pb-2 transition-colors',
          isOver && 'bg-primary-soft/60 ring-1 ring-inset ring-primary/30',
        )}
      >
        {tasks.length === 0 ? (
          <EmptyState
            size="inline"
            title={isOver ? 'Drop here' : 'Nothing here'}
            className="py-6"
          />
        ) : (
          <>
            {visible.map((task) => (
              <DraggableCard
                key={task.id}
                task={task}
                assignee={task.assigneeId ? users.get(task.assigneeId) : undefined}
              />
            ))}

            {remaining > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-2xs"
                onClick={() => setVisibleCount((count) => count + COLUMN_PAGE_SIZE)}
              >
                Show {formatNumber(Math.min(remaining, COLUMN_PAGE_SIZE))} more
                <span className="font-mono text-muted-foreground">
                  ({formatNumber(remaining)} left)
                </span>
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

function DraggableCard({ task, assignee }: { task: EpmTask; assignee?: EpmUser }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <KanbanCard task={task} assignee={assignee} />
    </div>
  );
}

function KanbanCard({
  task,
  assignee,
  dragging = false,
}: {
  task: EpmTask;
  assignee?: EpmUser;
  dragging?: boolean;
}) {
  const due = describeDueDate(task.dueDate, task.statusCategory === 'done');

  return (
    <article
      className={cn(
        'select-none rounded-lg border border-border bg-surface p-2.5 shadow-xs transition-shadow',
        dragging ? 'rotate-1 shadow-elevated' : 'hover:border-primary/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/tasks/${task.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          className="font-mono text-2xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
        >
          {task.key}
        </Link>
        <PriorityBadge priority={task.priority} label={task.priorityRef.name} />
      </div>

      <p className="mt-1.5 line-clamp-3 text-xs font-medium leading-snug text-foreground">
        {task.subject}
      </p>

      {task.labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.labels.slice(0, 2).map((label) => (
            <Badge key={label} size="sm" tone="neutral">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border pt-2">
        <div className="flex items-center gap-2">
          <UserAvatarWithTooltip user={assignee} size="xs" />
          {task.storyPoints ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs font-medium leading-none text-muted-foreground">
              {formatNumber(task.storyPoints)} pt
            </span>
          ) : null}
        </div>

        {task.dueDate ? (
          <span
            className={cn(
              'flex items-center gap-1 text-2xs',
              due.tone === 'overdue'
                ? 'font-medium text-danger-strong'
                : due.tone === 'today'
                  ? 'font-medium text-warning-strong'
                  : 'text-muted-foreground',
            )}
          >
            <CalendarClock className="h-3 w-3" aria-hidden />
            {due.label}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export function KanbanBoardSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: columns }).map((_, columnIndex) => (
        <Card
          key={columnIndex}
          className="w-72 shrink-0 space-y-2 bg-surface-sunken/60 p-2 shadow-none"
        >
          <Skeleton className="mx-1 h-3 w-24" />
          {Array.from({ length: 3 - (columnIndex % 2) }).map((__, cardIndex) => (
            <Skeleton key={cardIndex} className="h-24 rounded-lg" />
          ))}
        </Card>
      ))}
    </div>
  );
}
