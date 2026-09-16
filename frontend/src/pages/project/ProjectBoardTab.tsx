import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { FilterBar } from '@/components/tasks/FilterBar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { Card } from '@/components/ui/card';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useSprints } from '@/hooks/useSprints';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import { useUI } from '@/providers/UIProvider';
import type { ID, TaskFilters, TaskStatusCategory } from '@/types';

/**
 * How many work packages the board loads at once.
 *
 * A board is not a paged list — dragging between columns needs the whole
 * set — so it loads in one go and grows on request. What it must not do is
 * show a subset silently: the column counts come from what was fetched.
 */
const BOARD_PAGE_SIZE = 200;

/** Delivery board for a single project. */
export default function ProjectBoardTab() {
  const { projectId } = useParams();
  const { openTaskDrawer } = useUI();
  const [filters, setFilters] = useState<TaskFilters>({ projectId, pageSize: BOARD_PAGE_SIZE });

  const debouncedSearch = useDebounce(filters.search ?? '', 250);
  const query = useTasks({ ...filters, projectId, search: debouncedSearch || undefined });
  const sprintsQuery = useSprints();
  const { data: userList } = useUsers();
  const users = useUserMap();
  const updateTask = useUpdateTask();

  const tasks = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? tasks.length;

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) =>
          toast.success('Task moved', { description: `${task.key} is now ${status.replace('_', ' ')}` }),
        onError: () => toast.error('Unable to move the task'),
      },
    );
  };

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filters}
        onChange={setFilters}
        users={userList ?? []}
        sprints={sprintsQuery.data ?? []}
        hide={['project']}
        searchPlaceholder="Search this board..."
      />

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle="Unable to load the board"
        skeleton={<KanbanBoardSkeleton />}
        isEmpty={tasks.length === 0}
        empty={
          <Card>
            <EmptyState
              title="No tasks on this board"
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
          <TruncationNotice
            shown={tasks.length}
            total={total}
            itemLabel="task"
            affected="The column counts"
            step={BOARD_PAGE_SIZE}
            loading={query.isFetching}
            onLoadMore={() =>
              setFilters((current) => ({
                ...current,
                pageSize: (current.pageSize ?? BOARD_PAGE_SIZE) + BOARD_PAGE_SIZE,
              }))
            }
          />
        </div>
      </QueryBoundary>
    </div>
  );
}
