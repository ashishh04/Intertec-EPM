import { useParams } from 'react-router-dom';
import { GanttChart, GanttChartSkeleton } from '@/components/gantt/GanttChart';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { SectionHeader } from '@/components/common/PageHeader';
import { useTasks } from '@/hooks/useTasks';
import { useProjectMilestones } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';

/** Schedule view for a single project. */
export default function ProjectGanttTab() {
  const { projectId } = useParams();
  const tasksQuery = useTasks({ projectId, pageSize: 200, sortBy: 'dueDate', sortDir: 'asc' });
  const milestonesQuery = useProjectMilestones(projectId);
  const users = useUserMap();

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Timeline"
        description="Scheduled work packages, dependencies and milestones"
      />
      <QueryBoundary
        isLoading={tasksQuery.isLoading}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle="Unable to load the timeline"
        skeleton={<GanttChartSkeleton />}
      >
        <GanttChart
          tasks={tasksQuery.data?.items ?? []}
          users={users}
          milestones={milestonesQuery.data ?? []}
        />
      </QueryBoundary>
    </div>
  );
}
