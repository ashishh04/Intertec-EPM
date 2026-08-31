import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SquareKanban } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { FilterBar } from '@/components/tasks/FilterBar';
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
import { useUI } from '@/providers/UIProvider';
import type { ID, TaskFilters, TaskStatus } from '@/types';

/** Board workspace with a project switcher, for teams that live on the board. */
export default function BoardsPage() {
  const { openTaskDrawer } = useUI();
  const projectsQuery = useProjects();
  const sprintsQuery = useSprints();
  const { data: userList } = useUsers();
  const users = useUserMap();
  const updateTask = useUpdateTask();

  const [projectId, setProjectId] = useState<ID | undefined>();
  const [filters, setFilters] = useState<TaskFilters>({ pageSize: 200 });

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
  const project = projectsQuery.data?.find((item) => item.id === projectId);

  const handleStatusChange = (taskId: ID, status: TaskStatus) => {
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
        <KanbanBoard
          tasks={tasks}
          users={users}
          onStatusChange={handleStatusChange}
          onCreate={(status) => openTaskDrawer({ projectId, status })}
        />
      </QueryBoundary>
    </div>
  );
}
