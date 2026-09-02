import { useParams } from 'react-router-dom';
import { CalendarRange, CircleDollarSign, Flag, ShieldAlert, Target, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { HealthIndicator, PriorityBadge } from '@/components/common/StatusBadge';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useProject, useProjectMilestones } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { PROJECT_STATUS_META, TONE_FILL } from '@/lib/domain';
import { cn, formatCurrency, formatLongDate, formatShortDate } from '@/lib/utils';
import type { HealthLevel } from '@/types';

const HEALTH_DIMENSIONS: { key: keyof ProjectHealthKeys; label: string; hint: string }[] = [
  { key: 'scope', label: 'Scope', hint: 'Change requests and requirement stability' },
  { key: 'schedule', label: 'Schedule', hint: 'Progress against the committed plan' },
  { key: 'resources', label: 'Resources', hint: 'Staffing and skill coverage' },
  { key: 'budget', label: 'Budget', hint: 'Spend against the approved envelope' },
  { key: 'overall', label: 'Overall', hint: 'Aggregated delivery confidence' },
];

type ProjectHealthKeys = { scope: HealthLevel; schedule: HealthLevel; resources: HealthLevel; budget: HealthLevel; overall: HealthLevel };

/** Project summary: facts, progress, health, milestones and recent activity. */
export default function ProjectOverviewTab() {
  const { projectId } = useParams();
  const { data: project, isLoading } = useProject(projectId);
  const milestonesQuery = useProjectMilestones(projectId);
  const activityQuery = useActivity({ projectId, limit: 8 });
  const users = useUserMap();

  if (isLoading || !project) {
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const owner = users.get(project.ownerId);
  const budgetPct = Math.round((project.budgetUsed / Math.max(1, project.budgetTotal)) * 100);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {/* Summary */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Project summary</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-xs leading-relaxed text-muted-foreground">{project.description}</p>

            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="epm-eyebrow">Owner</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <UserAvatar user={owner} size="sm" />
                  <span className="text-xs font-medium">{owner?.name ?? 'Unassigned'}</span>
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Start date</dt>
                <dd className="mt-1 font-mono text-xs">{formatLongDate(project.startDate)}</dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Target date</dt>
                <dd className="mt-1 font-mono text-xs">{formatLongDate(project.dueDate)}</dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Status</dt>
                <dd className="mt-1 text-xs font-medium">
                  {PROJECT_STATUS_META[project.status].label}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Priority</dt>
                <dd className="mt-1">
                  <PriorityBadge priority={project.priority} />
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Open risks</dt>
                <dd className="mt-1 flex items-center gap-1.5 text-xs font-medium">
                  <ShieldAlert
                    className={cn(
                      'h-3.5 w-3.5',
                      project.openRiskCount > 2 ? 'text-danger' : 'text-warning',
                    )}
                    aria-hidden
                  />
                  {project.openRiskCount}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Progress */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Delivery progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="epm-eyebrow">Completion</p>
                <p className="mt-0.5 font-mono text-3xl font-semibold tabular-nums">
                  {project.progress}
                  <span className="text-lg text-muted-foreground">%</span>
                </p>
              </div>
              <div className="text-right">
                <p className="epm-eyebrow">Work packages</p>
                <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">
                  {project.completedTaskCount} / {project.taskCount} complete
                </p>
              </div>
            </div>

            <ProgressBar
              value={project.progress}
              size="lg"
              tone={PROJECT_STATUS_META[project.status].tone}
              label={`${project.name} completion`}
            />

            <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
              <SummaryStat
                icon={CalendarRange}
                label="Target"
                value={formatShortDate(project.dueDate)}
              />
              <SummaryStat
                icon={Users}
                label="Team size"
                value={`${project.memberIds.length} members`}
              />
              <SummaryStat
                icon={CircleDollarSign}
                label="Budget used"
                value={`${formatCurrency(project.budgetUsed)} of ${formatCurrency(project.budgetTotal)}`}
                sub={`${budgetPct}% consumed`}
              />
            </div>
          </CardContent>
        </Card>

        {/* Milestones */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Milestones</CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            <QueryBoundary
              isLoading={milestonesQuery.isLoading}
              isError={milestonesQuery.isError}
              onRetry={() => milestonesQuery.refetch()}
              skeleton={<Skeleton className="h-16 w-full" />}
            >
              <ol className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-0">
                <span
                  className="absolute left-[7px] top-2 hidden h-px w-full bg-border sm:block"
                  aria-hidden
                />
                {(milestonesQuery.data ?? []).map((milestone) => (
                  <li key={milestone.id} className="relative flex-1 sm:pr-3">
                    <div className="flex items-center gap-2 sm:block">
                      <span
                        className={cn(
                          'relative z-10 block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-surface',
                          milestone.status === 'completed'
                            ? TONE_FILL.success
                            : milestone.status === 'in_progress'
                              ? TONE_FILL.primary
                              : 'bg-border',
                        )}
                        aria-hidden
                      />
                      <div className="sm:mt-2">
                        <p className="text-xs font-medium">{milestone.name}</p>
                        <p className="font-mono text-2xs text-muted-foreground">
                          {formatShortDate(milestone.date)}
                        </p>
                        <Badge
                          size="sm"
                          tone={
                            milestone.status === 'completed'
                              ? 'success'
                              : milestone.status === 'in_progress'
                                ? 'primary'
                                : 'neutral'
                          }
                          className="mt-1"
                        >
                          {milestone.status === 'completed'
                            ? 'Completed'
                            : milestone.status === 'in_progress'
                              ? 'In progress'
                              : 'Upcoming'}
                        </Badge>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>

      {/* Right rail */}
      <div className="space-y-5">
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Project health</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <ul className="space-y-3">
              {HEALTH_DIMENSIONS.map((dimension) => (
                <li key={dimension.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{dimension.label}</p>
                    <p className="text-2xs text-muted-foreground">{dimension.hint}</p>
                  </div>
                  <HealthIndicator level={project.health[dimension.key]} className="shrink-0" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <Flag className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <QueryBoundary
              isLoading={activityQuery.isLoading}
              isError={activityQuery.isError}
              onRetry={() => activityQuery.refetch()}
              skeleton={<ActivityTimelineSkeleton rows={4} />}
            >
              <ActivityTimeline entries={activityQuery.data ?? []} users={users} limit={6} />
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryStat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex gap-2.5">
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <p className="epm-eyebrow">{label}</p>
        <p className="mt-0.5 truncate text-xs font-medium">{value}</p>
        {sub ? <p className="text-2xs text-muted-foreground">{sub}</p> : null}
      </div>
    </div>
  );
}
