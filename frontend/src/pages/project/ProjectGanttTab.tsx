import { useParams } from 'react-router-dom';
import { GanttChart, GanttChartSkeleton } from '@/components/gantt/GanttChart';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { SectionHeader } from '@/components/common/PageHeader';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { useTasks } from '@/hooks/useTasks';
import { useProjectMilestones } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';

/**
 * How many work packages the timeline draws at once. A timeline is read as a
 * whole, so it loads in one go; the notice under it says when it stops short.
 */
const GANTT_PAGE_SIZE = 200;

/** Schedule view for a single project. */
export default function ProjectGanttTab() {
  const { projectId } = useParams();
  const tasksQuery = useTasks({
    projectId,
    pageSize: GANTT_PAGE_SIZE,
    sortBy: 'dueDate',
    sortDir: 'asc',
  });
  const milestonesQuery = useProjectMilestones(projectId);
  const users = useUserMap();
  const tasks = tasksQuery.data?.items ?? [];
  const total = tasksQuery.data?.total ?? tasks.length;

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
        <div className="space-y-3">
          <GanttChart tasks={tasks} users={users} milestones={milestonesQuery.data ?? []} />
          <TruncationNotice shown={tasks.length} total={total} itemLabel="task" affected="The bars" />
        </div>
      </QueryBoundary>
    </div>
  );
}
