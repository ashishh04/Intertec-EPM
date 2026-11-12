import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useProjects, useProjectMilestones } from '@/hooks/useProjects';
import { useProjectCriticalPath } from '@/hooks/useSchedule';
import { useTaskTimeline } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { EpmProject, ID } from '@/types';

/**
 * The project the page opens on when the address names none: the one last
 * looked at in this browser, if it is still there; otherwise the first with
 * work to draw, favourites first and then in the list's order. The list is
 * newest first, so opening on its first entry meant opening on a project just
 * created, with nothing on it, while the others had a plan.
 */
function openingProject(projects: EpmProject[], remembered: ID | null): ID | undefined {
  if (remembered && projects.some((project) => project.id === remembered)) return remembered;
  const ordered = [...projects.filter((project) => project.favorited), ...projects.filter((project) => !project.favorited)];
  const delivery = ordered.filter((project) => !project.templated);
  return (
    // Open work with a date first: that is what the chart draws.
    delivery.find((project) => project.forecastFinish) ??
    delivery.find((project) => project.taskCount > 0) ??
    ordered.find((project) => project.forecastFinish) ??
    ordered[0]
  )?.id;
}

/** Portfolio timeline with a project switcher. */
export default function GanttPage() {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data;
  const [params, setParams] = useSearchParams();
  const [remembered, remember] = useLocalStorage<ID | null>('epm.gantt.project', null);

  // The project is in the address, so a reload, the back button or a shared
  // link shows the same plan; an address naming a project the reader cannot
  // see falls back like a bare one.
  const asked = params.get('project');
  const projectId = useMemo<ID | undefined>(() => {
    if (!projects?.length) return undefined;
    const named = projects.find((project) => project.id === asked);
    return named ? named.id : openingProject(projects, remembered);
  }, [projects, asked, remembered]);

  const chooseProject = (value: ID) => {
    remember(value);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('project', value);
        return next;
      },
      { replace: true },
    );
  };

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
        title={t('Gantt')}
        description={t('Schedule, dependencies and milestones across the delivery plan.')}
        meta={
          project ? (
            <span className="font-mono text-2xs text-muted-foreground">{project.identifier}</span>
          ) : null
        }
        actions={
          <Select value={projectId ?? ''} onValueChange={(value) => chooseProject(value as ID)}>
            <SelectTrigger className="w-56" aria-label={t('Select a project timeline')}>
              <SelectValue placeholder={t('Select a project')} />
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

      {/* While another project's timeline loads, the query holds the last
          project's as a placeholder: show the skeleton, not that project's bars
          (or its "Nothing scheduled yet") under the new project's name. */}
      <QueryBoundary
        isLoading={tasksQuery.isLoading || projectsQuery.isLoading || tasksQuery.isPlaceholderData}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle={t('Unable to load the timeline')}
        skeleton={<GanttChartSkeleton />}
      >
        <div className="space-y-3">
          <GanttChart
            tasks={tasks}
            users={users}
            milestones={milestonesQuery.data ?? []}
            schedule={criticalPath.data}
          />
          <TruncationNotice shown={tasks.length} total={total} affected={t('The bars')} />
        </div>
      </QueryBoundary>
    </div>
  );
}
