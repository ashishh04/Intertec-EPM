import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, LayoutList, Plus, SquareKanban, Target } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { FilterBar } from '@/components/tasks/FilterBar';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { useDebounce } from '@/hooks/useDebounce';
import { usePagination } from '@/hooks/usePagination';
import { pluralize } from '@/lib/utils';
import type { ID, EpmProject, EpmTask, EpmUser, TaskFilters, TaskStatus } from '@/types';
import { toast } from 'sonner';

type ViewMode = 'list' | 'board';

const SECTIONS: { key: NonNullable<TaskFilters['bucket']>; title: string; hint: string }[] = [
  { key: 'overdue', title: 'Overdue', hint: 'Past their committed date' },
  { key: 'today', title: 'Today', hint: 'Due before end of day' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Scheduled ahead' },
  { key: 'completed', title: 'Recently Completed', hint: 'Closed work' },
];

/**
 * The user's personal command centre: everything assigned to them, grouped by
 * urgency, with the same filter and board affordances as the project views.
 */
export default function MyWorkPage() {
  const { user } = useAuth();
  const { openTaskDrawer } = useUI();
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<ViewMode>('list');

  const [filters, setFilters] = useState<TaskFilters>({
    assigneeId: searchParams.get('assignee') ?? undefined,
    bucket: (searchParams.get('bucket') as TaskFilters['bucket']) ?? undefined,
    pageSize: 200,
    sortBy: 'dueDate',
    sortDir: 'asc',
  });

  const debouncedSearch = useDebounce(filters.search ?? '', 250);

  const effectiveFilters: TaskFilters = {
    ...filters,
    search: debouncedSearch || undefined,
    assigneeId: filters.assigneeId ?? user?.id,
  };

  const tasksQuery = useTasks(effectiveFilters);
  const projectsQuery = useProjects();
  const sprintsQuery = useSprints();
  const users = useUserMap();
  const updateTask = useUpdateTask();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const tasks = tasksQuery.data?.items ?? [];

  const grouped = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const buckets: Record<string, EpmTask[]> = {
      overdue: [],
      today: [],
      upcoming: [],
      completed: [],
    };

    for (const task of tasks) {
      if (task.status === 'done') {
        buckets.completed.push(task);
        continue;
      }
      if (!task.dueDate) {
        buckets.upcoming.push(task);
        continue;
      }
      const due = new Date(`${task.dueDate}T00:00:00`);
      if (due < today) buckets.overdue.push(task);
      else if (due.getTime() === today.getTime()) buckets.today.push(task);
      else buckets.upcoming.push(task);
    }

    return buckets;
  }, [tasks]);

  const visibleSections = filters.bucket
    ? SECTIONS.filter((section) => section.key === filters.bucket)
    : SECTIONS;

  const handleStatusChange = (taskId: ID, status: TaskStatus) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success('Task updated', { description: `${task.key} moved` }),
        onError: () => toast.error('Unable to save changes'),
      },
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="My Work"
        description="Everything assigned to you, ordered by what needs attention first."
        meta={
          tasksQuery.data ? (
            <Badge tone="neutral" size="sm">
              {tasksQuery.data.total} {pluralize(tasksQuery.data.total, 'item')}
            </Badge>
          ) : null
        }
        actions={
          <Button onClick={() => openTaskDrawer({ assigneeId: user?.id })}>
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        }
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        projects={projectsQuery.data ?? []}
        sprints={sprintsQuery.data ?? []}
        hide={['assignee']}
        searchPlaceholder="Search my tasks..."
        trailing={
          <Tabs value={view} onValueChange={(value) => setView(value as ViewMode)}>
            <TabsList aria-label="View mode">
              <TabsTrigger value="list" aria-label="List view">
                <LayoutList className="h-3.5 w-3.5" />
                List
              </TabsTrigger>
              <TabsTrigger value="board" aria-label="Board view">
                <SquareKanban className="h-3.5 w-3.5" />
                Board
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <QueryBoundary
        isLoading={tasksQuery.isLoading}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle="Unable to load your work"
        skeleton={
          view === 'board' ? (
            <KanbanBoardSkeleton />
          ) : (
            <Card>
              <TaskListSkeleton rows={7} />
            </Card>
          )
        }
        isEmpty={tasks.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={CheckCircle2}
              title="No tasks found"
              description="Your work queue is clear. Adjust the filters or create something new."
              action={{ label: 'Create a task', onClick: () => openTaskDrawer({ assigneeId: user?.id }) }}
            />
          </Card>
        }
      >
        {view === 'board' ? (
          <KanbanBoard
            tasks={tasks}
            users={users}
            onStatusChange={handleStatusChange}
            onCreate={(status) => openTaskDrawer({ status, assigneeId: user?.id })}
          />
        ) : (
          <div className="space-y-5">
            {visibleSections.map((section) => {
              const items = grouped[section.key] ?? [];
              if (items.length === 0 && filters.bucket !== section.key) return null;

              return (
                <WorkSection
                  key={section.key}
                  title={section.title}
                  hint={section.hint}
                  tasks={items}
                  projects={projectsById}
                  users={users}
                  resetKey={`${debouncedSearch}|${filters.projectId ?? ''}|${filters.sprintId ?? ''}`}
                />
              );
            })}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

/**
 * One urgency bucket in the personal queue.
 *
 * Each bucket pages independently so a long backlog of upcoming work never
 * pushes the overdue section off the screen.
 */
function WorkSection({
  title,
  hint,
  tasks,
  projects,
  users,
  resetKey,
}: {
  title: string;
  hint: string;
  tasks: EpmTask[];
  projects: Map<ID, EpmProject>;
  users: Map<ID, EpmUser>;
  resetKey: string;
}) {
  const paged = usePagination(tasks, { pageSize: 8, resetKey });

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="font-mono text-2xs text-muted-foreground">{tasks.length}</span>
        <span className="text-2xs text-muted-foreground">· {hint}</span>
      </div>

      <Card className="overflow-hidden">
        {tasks.length === 0 ? (
          <EmptyState size="inline" icon={Target} title={`Nothing ${title.toLowerCase()}`} />
        ) : (
          <>
            <div className="divide-y divide-border">
              {paged.items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  project={projects.get(task.projectId)}
                  assignee={task.assigneeId ? users.get(task.assigneeId) : undefined}
                />
              ))}
            </div>
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              itemLabel="task"
              className="border-t border-border"
            />
          </>
        )}
      </Card>
    </section>
  );
}
