import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SquareKanban } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { FilterBar } from '@/components/tasks/FilterBar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import { pluralize } from '@/lib/utils';
import { useUI } from '@/providers/UIProvider';
import type { ID, TaskFilters, TaskStatusCategory } from '@/types';

/**
 * How many work packages the board loads at once.
 *
 * A board is not a paged list — dragging a card between columns only makes
 * sense when both columns hold the whole set, so this loads in one go and
 * grows on request rather than stepping through pages. What it must not do is
 * show a subset silently: the column counts come from what was fetched, so a
 * truncated board reports wrong totals as if they were right.
 */
const BOARD_PAGE_SIZE = 200;

/** Board workspace with a project switcher, for teams that live on the board. */
export default function BoardsPage() {
  const { openTaskDrawer } = useUI();
  const projectsQuery = useProjects();
  const sprintsQuery = useSprints();
  const { data: userList } = useUsers();
  const users = useUserMap();
  const updateTask = useUpdateTask();

  const [projectId, setProjectId] = useState<ID | undefined>();
  const [filters, setFilters] = useState<TaskFilters>({ pageSize: BOARD_PAGE_SIZE });

  // Default to the first project once the list loads.
  useEffect(() => {
    if (!projectId && projectsQuery.data?.length) setProjectId(projectsQuery.data[0].id);
  }, [projectsQuery.data, projectId]);

  const debouncedSearch = useDebounce(filters.search ?? '', 250);
  const tasksQuery = useTasks({
    ...filters,
    projectId,
    search: debouncedSearch || undefined,
  });

  const tasks = useMemo(() => tasksQuery.data?.items ?? [], [tasksQuery.data]);
  const total = tasksQuery.data?.total ?? tasks.length;
  const hidden = Math.max(0, total - tasks.length);
  const project = projectsQuery.data?.find((item) => item.id === projectId);

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success('Task moved', { description: task.key }),
        onError: () => toast.error('Unable to move the task'),
      },
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Boards"
        description="Visual delivery flow for any project in the portfolio."
        meta={
          project ? (
            <span className="font-mono text-2xs text-muted-foreground">{project.identifier}</span>
          ) : null
        }
        actions={
          <Select value={projectId} onValueChange={(value) => setProjectId(value as ID)}>
            <SelectTrigger className="w-56" aria-label="Select a board">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {(projectsQuery.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        users={userList ?? []}
        sprints={sprintsQuery.data ?? []}
        hide={['project']}
        searchPlaceholder="Search this board..."
      />

      <QueryBoundary
        isLoading={tasksQuery.isLoading || projectsQuery.isLoading}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle="Unable to load the board"
        skeleton={<KanbanBoardSkeleton />}
        isEmpty={tasks.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={SquareKanban}
              title="This board is empty"
              description="Create the first work package to start planning delivery."
              action={{ label: 'Create a task', onClick: () => openTaskDrawer({ projectId }) }}
            />
          </Card>
        }
      >
        <div className="space-y-3">
          <KanbanBoard
            tasks={tasks}
            users={users}
            onStatusChange={handleStatusChange}
            onCreate={(status) => openTaskDrawer({ projectId, status })}
          />

          {/* Only when the board is actually showing a subset. Silence here
              would mean the column counts are wrong and nothing says so. */}
          {hidden > 0 ? (
            <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="text-2xs text-muted-foreground">
                Showing <span className="font-medium text-foreground">{tasks.length}</span> of{' '}
                <span className="font-medium text-foreground">{total}</span>{' '}
                {pluralize(total, 'task')}. The column counts cover what is loaded.
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={tasksQuery.isFetching}
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    pageSize: (current.pageSize ?? BOARD_PAGE_SIZE) + BOARD_PAGE_SIZE,
                  }))
                }
              >
                {tasksQuery.isFetching ? 'Loading…' : `Load ${Math.min(hidden, BOARD_PAGE_SIZE)} more`}
              </Button>
            </Card>
          ) : null}
        </div>
      </QueryBoundary>
    </div>
  );
}
