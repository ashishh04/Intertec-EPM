import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Timer } from 'lucide-react';
import { SprintSummary, SprintSummarySkeleton } from '@/components/dashboard/SprintSummary';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { SectionHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Card } from '@/components/ui/card';
import { useActiveSprint } from '@/hooks/useSprints';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { useUI } from '@/providers/UIProvider';
import type { ID, TaskStatusCategory } from '@/types';

/** The active sprint as it applies to this project. */
export default function ProjectSprintTab() {
  const { projectId } = useParams();
  const { openTaskDrawer } = useUI();
  const sprintQuery = useActiveSprint();
  const users = useUserMap();
  const updateTask = useUpdateTask();

  const tasksQuery = useTasks({
    projectId,
    sprintId: sprintQuery.data?.id,
    pageSize: 200,
  });

  const tasks = useMemo(() => tasksQuery.data?.items ?? [], [tasksQuery.data]);

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success('Task moved', { description: task.key }),
        onError: () => toast.error('Unable to move the task'),
      },
    );
  };

  const inSprint = sprintQuery.data?.projectIds.includes(projectId ?? '');

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-1">
          {sprintQuery.isLoading || !sprintQuery.data ? (
            <SprintSummarySkeleton />
          ) : (
            <SprintSummary sprint={sprintQuery.data} />
          )}
        </div>

        <div className="space-y-3 lg:col-span-2">
          <SectionHeader
            title="Sprint board"
            description={
              inSprint
                ? 'Work packages from this project committed to the active sprint'
                : 'This project has no work in the active sprint'
            }
          />

          <QueryBoundary
            isLoading={tasksQuery.isLoading || sprintQuery.isLoading}
            isError={tasksQuery.isError}
            error={tasksQuery.error}
            onRetry={() => tasksQuery.refetch()}
            errorTitle="Unable to load sprint work"
            skeleton={<KanbanBoardSkeleton columns={3} />}
            isEmpty={tasks.length === 0}
            empty={
              <Card>
                <EmptyState
                  icon={Timer}
                  title="Nothing committed to this sprint"
                  description="Add work packages to the sprint from the project backlog."
                  action={{
                    label: 'Create a task',
                    onClick: () => openTaskDrawer({ projectId, sprintId: sprintQuery.data?.id }),
                  }}
                />
              </Card>
            }
          >
            <KanbanBoard
              tasks={tasks}
              users={users}
              onStatusChange={handleStatusChange}
              onCreate={(status) =>
                openTaskDrawer({ projectId, status, sprintId: sprintQuery.data?.id })
              }
              columns={['todo', 'in_progress', 'review', 'done']}
            />
          </QueryBoundary>
        </div>
      </div>
    </div>
  );
}
