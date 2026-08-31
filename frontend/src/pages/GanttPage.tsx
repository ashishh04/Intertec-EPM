import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { GanttChart, GanttChartSkeleton } from '@/components/gantt/GanttChart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjects, useProjectMilestones } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import type { ID } from '@/types';

/** Portfolio timeline with a project switcher. */
export default function GanttPage() {
  const projectsQuery = useProjects();
  const [projectId, setProjectId] = useState<ID | undefined>();

  useEffect(() => {
    if (!projectId && projectsQuery.data?.length) setProjectId(projectsQuery.data[0].id);
  }, [projectsQuery.data, projectId]);

  const tasksQuery = useTasks({
    projectId,
    pageSize: 200,
    sortBy: 'dueDate',
    sortDir: 'asc',
  });
  const milestonesQuery = useProjectMilestones(projectId);
  const users = useUserMap();

  const project = projectsQuery.data?.find((item) => item.id === projectId);

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
        <GanttChart
          tasks={tasksQuery.data?.items ?? []}
          users={users}
          milestones={milestonesQuery.data ?? []}
        />
      </QueryBoundary>
    </div>
  );
}
