import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { GanttChart, GanttChartSkeleton } from '@/components/gantt/GanttChart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjects, useProjectMilestones } from '@/hooks/useProjects';
import { useProjectCriticalPath } from '@/hooks/useSchedule';
import { useTaskTimeline } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import type { ID } from '@/types';

/** Portfolio timeline with a project switcher. */
export default function GanttPage() {
  const projectsQuery = useProjects();
  const [projectId, setProjectId] = useState<ID | undefined>();

  useEffect(() => {
    if (!projectId && projectsQuery.data?.length) setProjectId(projectsQuery.data[0].id);
  }, [projectsQuery.data, projectId]);

  // A timeline is read as a whole, so it loads every page; the notice under
  // the chart says when a project has more scheduled work than is drawn.
  const tasksQuery = useTaskTimeline(projectId);
  const criticalPath = useProjectCriticalPath(projectId);
  const milestonesQuery = useProjectMilestones(projectId);
  const users = useUserMap();

  const project = projectsQuery.data?.find((item) => item.id === projectId);
  const tasks = tasksQuery.data?.items ?? [];
  const total = tasksQuery.data?.total ?? tasks.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gantt"
        description="Schedule, dependencies and milestones across the delivery plan."
        meta={
          project ? (
            <span className="font-mono text-2xs text-muted-foreground">{project.identifier}</span>
          ) : null
        }
        actions={
          <Select value={projectId} onValueChange={(value) => setProjectId(value as ID)}>
            <SelectTrigger className="w-56" aria-label="Select a project timeline">
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

      <QueryBoundary
        isLoading={tasksQuery.isLoading || projectsQuery.isLoading}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle="Unable to load the timeline"
        skeleton={<GanttChartSkeleton />}
      >
        <div className="space-y-3">
          <GanttChart
            tasks={tasks}
            users={users}
            milestones={milestonesQuery.data ?? []}
            schedule={criticalPath.data}
          />
          <TruncationNotice shown={tasks.length} total={total} itemLabel="task" affected="The bars" />
        </div>
      </QueryBoundary>
    </div>
  );
}
