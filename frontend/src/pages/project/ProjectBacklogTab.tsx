import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
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
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Inbox, Plus, Timer } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useBacklog, useBacklogMove } from '@/hooks/useBoards';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { cn, formatShortDate } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import type { BacklogSprint, EpmTask, EpmUser, ID, ProjectBacklog } from '@/types';

/** The backlog's own list id; a sprint's list goes by the sprint's id. */
const BACKLOG = 'backlog';
const LIST_PREFIX = 'list::';
const rowKey = (listId: string, taskId: ID) => `${listId}::${taskId}`;

interface PlanList {
  id: string;
  tasks: EpmTask[];
}

const listsOf = (data: ProjectBacklog): PlanList[] => [
  { id: BACKLOG, tasks: data.backlog },
  ...data.sprints.map((entry) => ({ id: entry.sprint.id, tasks: entry.items })),
];

/**
 * The project's backlog, in order, beside the sprints it can plan into. Work
 * is dragged up and down the backlog to rank it, and across into a sprint to
 * plan it there (or back). Each sprint shows its points against the project's
 * velocity, so a sprint taking on more than the team usually finishes says so.
 */
export default function ProjectBacklogTab() {
  const { projectId } = useParams();
  const { openTaskDrawer } = useUI();
  const { canInProject } = useAuth();
  const backlog = useBacklog(projectId);
  const move = useBacklogMove(projectId ?? '');
  const users = useUserMap();
  const [lists, setLists] = useState<PlanList[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    if (backlog.data) setLists(listsOf(backlog.data));
  }, [backlog.data]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const canPlan = Boolean(backlog.data?.canPlan);
  const parse = (key: string) => {
    const [listId, taskId] = key.split('::');
    return { listId: listId!, taskId: taskId! };
  };
  const activeTask = useMemo(() => {
    if (!activeKey) return undefined;
    const { listId, taskId } = parse(activeKey);
    return lists.find((list) => list.id === listId)?.tasks.find((task) => task.id === taskId);
  }, [activeKey, lists]);

  if (!projectId) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveKey(null);
    if (!event.over) return;
    const from = parse(String(event.active.id));
    const source = lists.find((list) => list.id === from.listId);
    const task = source?.tasks.find((one) => one.id === from.taskId);
    if (!source || !task) return;

    const overKey = String(event.over.id);
    const toListId = overKey.startsWith(LIST_PREFIX) ? overKey.slice(LIST_PREFIX.length) : parse(overKey).listId;
    const target = lists.find((list) => list.id === toListId);
    if (!target) return;
    const overIndex = overKey.startsWith(LIST_PREFIX) ? -1 : target.tasks.findIndex((one) => one.id === parse(overKey).taskId);

    let next: EpmTask[];
    if (toListId === from.listId) {
      const oldIndex = source.tasks.findIndex((one) => one.id === task.id);
      const newIndex = overIndex < 0 ? source.tasks.length - 1 : overIndex;
      if (oldIndex === newIndex) return;
      next = arrayMove(source.tasks, oldIndex, newIndex);
    } else {
      next = [...target.tasks];
      next.splice(overIndex < 0 ? next.length : overIndex, 0, task);
    }
    const at = next.findIndex((one) => one.id === task.id);
    const beforeId = next[at + 1]?.id;

    setLists((current) =>
      current.map((list) => {
        if (list.id === toListId) return { ...list, tasks: next };
        if (list.id === from.listId) return { ...list, tasks: list.tasks.filter((one) => one.id !== task.id) };
        return list;
      }),
    );
    move.mutate(
      { workPackageId: task.id, sprintId: toListId === BACKLOG ? null : toListId, ...(beforeId ? { beforeId } : {}) },
      {
        onError: (error) => {
          if (backlog.data) setLists(listsOf(backlog.data));
          toast.error(t('Unable to move the task'), { description: error instanceof Error ? error.message : undefined });
        },
      },
    );
  };

  const backlogList = lists.find((list) => list.id === BACKLOG);
  const sprintEntries = backlog.data?.sprints ?? [];
  const mayCreate = canInProject(projectId, 'task:create');

  return (
    <QueryBoundary
      isLoading={backlog.isLoading}
      isError={backlog.isError}
      error={backlog.error}
      onRetry={() => backlog.refetch()}
      errorTitle={t('Unable to load the backlog')}
      skeleton={<PageSkeleton />}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) => setActiveKey(String(event.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveKey(null)}
      >
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <PlanCard
            listId={BACKLOG}
            tasks={backlogList?.tasks ?? []}
            users={users}
            canPlan={canPlan}
            title={t('Backlog')}
            icon={Inbox}
            subtitle={t('{count, plural, one {# task in no sprint} other {# tasks in no sprint}}, highest first', { count: backlogList?.tasks.length ?? 0 })}
            empty={t('Nothing waiting: every open task is in a sprint.')}
            action={
              mayCreate ? (
                <Button size="sm" variant="secondary" onClick={() => openTaskDrawer({ projectId })}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('Create task')}
                </Button>
              ) : null
            }
          />
          <div className="space-y-4">
            {sprintEntries.length === 0 ? (
              <Card>
                <EmptyState icon={Timer} title={t('No sprints to plan into')} description={t('Create a sprint for this project, or share one with it, to plan work into.')} />
              </Card>
            ) : (
              sprintEntries.map((entry) => (
                <SprintPlanCard key={entry.sprint.id} entry={entry} tasks={lists.find((list) => list.id === entry.sprint.id)?.tasks ?? []} users={users} canPlan={canPlan} />
              ))
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }}>
          {activeTask ? <PlanRow task={activeTask} assignee={activeTask.assigneeId ? users.get(activeTask.assigneeId) : undefined} dragging /> : null}
        </DragOverlay>
      </DndContext>
      {!canPlan ? <p className="mt-3 text-2xs text-muted-foreground">{t('Only someone who can edit this project’s tasks can plan them.')}</p> : null}
    </QueryBoundary>
  );
}

function SprintPlanCard({ entry, tasks, users, canPlan }: { entry: BacklogSprint; tasks: EpmTask[]; users: Map<ID, EpmUser>; canPlan: boolean }) {
  const points = tasks.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
  const over = entry.velocity !== undefined && points > entry.velocity;
  return (
    <PlanCard
      listId={entry.sprint.id}
      tasks={tasks}
      users={users}
      canPlan={canPlan}
      title={entry.sprint.name}
      icon={Timer}
      badge={
        <Badge size="sm" tone={entry.sprint.state === 'active' ? 'success' : 'neutral'}>
          {entry.sprint.state === 'active' ? t('Active') : t('Planned')}
        </Badge>
      }
      subtitle={
        entry.startDate || entry.endDate
          ? [entry.startDate, entry.endDate].map((day) => (day ? formatShortDate(day) : '…')).join(' – ')
          : t('No dates')
      }
      empty={t('Nothing planned yet. Drag work here from the backlog.')}
      action={
        <span className={cn('text-2xs tabular-nums', over ? 'font-medium text-warning-strong' : 'text-muted-foreground')}>
          {entry.velocity !== undefined
            ? t('{points, number} of about {velocity, number} pts', { points, velocity: entry.velocity })
            : t('{points, number} pts', { points })}
        </span>
      }
    />
  );
}

function PlanCard({
  listId,
  tasks,
  users,
  canPlan,
  title,
  icon: Icon,
  badge,
  subtitle,
  empty,
  action,
}: {
  listId: string;
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  canPlan: boolean;
  title: string;
  icon: typeof Inbox;
  badge?: React.ReactNode;
  subtitle: string;
  empty: string;
  action?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${LIST_PREFIX}${listId}`, disabled: !canPlan });
  return (
    <Card className="overflow-hidden" role="region" aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold" dir="auto">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="truncate">{title}</span>
            {badge}
          </h3>
          <p className="mt-0.5 text-2xs text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </header>
      <div ref={setNodeRef} className={cn('min-h-16 divide-y divide-border transition-colors', isOver && 'bg-primary-soft/40')}>
        <SortableContext items={tasks.map((task) => rowKey(listId, task.id))} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableRow key={task.id} id={rowKey(listId, task.id)} task={task} assignee={task.assigneeId ? users.get(task.assigneeId) : undefined} disabled={!canPlan} />
          ))}
        </SortableContext>
        {tasks.length === 0 ? <p className="px-4 py-5 text-center text-xs text-muted-foreground">{empty}</p> : null}
      </div>
    </Card>
  );
}

function SortableRow({ id, task, assignee, disabled }: { id: string; task: EpmTask; assignee?: EpmUser; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(isDragging && 'opacity-40')} {...attributes} {...listeners}>
      <PlanRow task={task} assignee={assignee} draggable={!disabled} />
    </div>
  );
}

function PlanRow({ task, assignee, draggable = false, dragging = false }: { task: EpmTask; assignee?: EpmUser; draggable?: boolean; dragging?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5 bg-surface px-3 py-2', dragging && 'rounded-md border border-border shadow-elevated')}>
      {draggable || dragging ? <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/60" aria-hidden /> : null}
      <Link
        to={`/tasks/${task.id}`}
        onPointerDown={(event) => event.stopPropagation()}
        className="shrink-0 font-mono text-2xs text-muted-foreground hover:text-primary hover:underline"
      >
        {task.key}
      </Link>
      <span className={cn('min-w-0 flex-1 truncate text-xs', task.status.isClosed && 'text-muted-foreground line-through')} dir="auto" title={task.subject}>
        {task.subject}
      </span>
      <Badge size="sm" tone="neutral" className="hidden shrink-0 sm:inline-flex">
        {task.status.name}
      </Badge>
      {task.storyPoints ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-2xs leading-none text-muted-foreground">
          {t('{points, number} pt', { points: task.storyPoints })}
        </span>
      ) : null}
      <UserAvatarWithTooltip user={assignee} size="xs" />
    </div>
  );
}
