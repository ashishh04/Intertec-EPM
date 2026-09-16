import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  CalendarRange,
  CircleDollarSign,
  Flag,
  Pencil,
  ShieldAlert,
  Target,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HealthOverrideDialog } from '@/components/projects/HealthOverrideDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSetProjectOwner } from '@/hooks/useProjects';
import { toast } from 'sonner';
import { ProjectPortfolioCard } from '@/components/portfolios/ProjectPortfolioCard';
import { ProjectHierarchyCard } from '@/components/projects/ProjectHierarchyCard';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { HealthIndicator, PriorityBadge } from '@/components/common/StatusBadge';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useProject, useProjectMilestones } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { HEALTH_META, PROJECT_STATUS_META, TONE_FILL } from '@/lib/domain';
import {
  cn,
  formatCurrency,
  formatLongDate,
  formatNumber,
  formatPercent,
  formatShortDate,
  pluralize,
} from '@/lib/utils';
import type { HealthDimension } from '@/types';

/** Sentinel: a select cannot hold an empty string as a value. */
const NO_OWNER = '__none__';

const HEALTH_DIMENSIONS: { key: HealthDimension; label: string; hint: string }[] = [
  { key: 'scope', label: 'Scope', hint: 'Change requests and requirement stability' },
  { key: 'schedule', label: 'Schedule', hint: 'Progress against the committed plan' },
  { key: 'resources', label: 'Resources', hint: 'Staffing and skill coverage' },
  { key: 'budget', label: 'Budget', hint: 'Spend against the approved envelope' },
  { key: 'overall', label: 'Overall', hint: 'Aggregated delivery confidence' },
];

/** Project summary: facts, progress, health, milestones and recent activity. */
export default function ProjectOverviewTab() {
  const { projectId } = useParams();
  const { data: project, isLoading } = useProject(projectId);
  const milestonesQuery = useProjectMilestones(projectId);
  const activityQuery = useActivity({ projectId, limit: 20 });

  // Both blocks page rather than grow: four milestones fit the strip, five
  // activity entries fit the column, and the card height stays put.
  const milestonesPaged = usePagination(milestonesQuery.data ?? [], { pageSize: 4 });
  const activityPaged = usePagination(activityQuery.data ?? [], { pageSize: 5 });
  const users = useUserMap();

  // Declared with the other hooks: the guard below returns early, and a hook
  // after it would run on some renders and not others.
  const { can, canInProject } = useAuth();
  const [healthOpen, setHealthOpen] = useState(false);
  const setOwner = useSetProjectOwner();
  const canEditProject = canInProject(project?.id, 'project:edit');

  // Whoever is on the project. Owning a project you have no access to would be
  // a title without the ability to act on it.
  const memberOptions = (project?.memberIds ?? [])
    .map((id) => users.get(id))
    .filter((user): user is NonNullable<typeof user> => Boolean(user))
    .sort((a, b) => a.name.localeCompare(b.name));
  const canOverrideHealth = can('health:manage');

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
          <CardHeader variant="compact">
            <CardTitle>Project summary</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">{project.description}</p>

            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="epm-eyebrow">Owner</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <UserAvatar user={owner} size="sm" />
                  {/* Editable, and EPM's own: an OpenProject project has no
                      owner attribute, so this read "Unassigned" for every
                      project with nothing anywhere to change it. Health
                      notifications go to whoever is set here. */}
                  {canEditProject ? (
                    <Select
                      value={project.ownerId || NO_OWNER}
                      onValueChange={(value) =>
                        setOwner.mutate(
                          { id: project.id, ownerId: value === NO_OWNER ? '' : value },
                          {
                            onSuccess: () => toast.success('Owner updated'),
                            onError: (error) =>
                              toast.error('That could not be saved', {
                                description:
                                  error instanceof Error ? error.message : undefined,
                              }),
                          },
                        )
                      }
                    >
                      <SelectTrigger className="h-7 w-full text-xs" aria-label="Project owner">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_OWNER}>Unassigned</SelectItem>
                        {memberOptions.map((member) => (
                          <SelectItem key={member.id} value={member.id}>
                            {member.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs font-medium">{owner?.name ?? 'Unassigned'}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Start date</dt>
                <dd className="mt-1 font-mono text-xs tabular-nums">
                  {formatLongDate(project.startDate)}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Target date</dt>
                <dd className="mt-1 font-mono text-xs tabular-nums">
                  {formatLongDate(project.dueDate)}
                </dd>
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
                  {formatNumber(project.openRiskCount)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Progress */}
        <Card>
          <CardHeader variant="compact">
            <CardTitle>Delivery progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="epm-eyebrow">Completion</p>
                <p className="mt-0.5 font-mono text-2xl font-semibold tabular-nums">
                  {formatNumber(project.progress)}
                  <span className="text-lg text-muted-foreground">%</span>
                </p>
              </div>
              <div className="text-right">
                <p className="epm-eyebrow">Work packages</p>
                <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">
                  {formatNumber(project.completedTaskCount)} / {formatNumber(project.taskCount)}
                  {' '}complete
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
                value={`${formatNumber(project.memberIds.length)} ${pluralize(project.memberIds.length, 'member')}`}
              />
              <SummaryStat
                icon={CircleDollarSign}
                label="Budget used"
                value={`${formatCurrency(project.budgetUsed)} of ${formatCurrency(project.budgetTotal)}`}
                sub={`${formatPercent(budgetPct)} consumed`}
              />
            </div>
          </CardContent>
        </Card>

        {/* Milestones */}
        <Card>
          <CardHeader variant="compact">
            <CardTitle>Milestones</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <QueryBoundary
              isLoading={milestonesQuery.isLoading}
              isError={milestonesQuery.isError}
              error={milestonesQuery.error}
              onRetry={() => milestonesQuery.refetch()}
              errorTitle="Unable to load milestones"
              skeleton={<Skeleton className="h-16 w-full" />}
              isEmpty={(milestonesQuery.data ?? []).length === 0}
              empty={
                <EmptyState
                  size="inline"
                  icon={Flag}
                  title="No milestones yet"
                  description="Milestones appear here once the plan has dated checkpoints."
                />
              }
            >
              <ol className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-0">
                <span
                  className="absolute left-[7px] top-2 hidden h-px w-full bg-border sm:block"
                  aria-hidden
                />
                {milestonesPaged.items.map((milestone) => (
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
                        <p className="font-mono text-2xs tabular-nums text-muted-foreground">
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
              {milestonesPaged.totalPages > 1 ? (
                <Pagination
                  variant="compact"
                  page={milestonesPaged.page}
                  pageSize={milestonesPaged.pageSize}
                  total={milestonesPaged.total}
                  onPageChange={milestonesPaged.setPage}
                  itemLabel="milestone"
                  className="mt-3 border-t border-border px-0 pt-2"
                />
              ) : null}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>

      {/* Right rail */}
      <div className="space-y-5">
        <ProjectPortfolioCard project={project} />

        {/* Next to the portfolio card because both answer "where does this
            project sit" — but this one is upstream's own hierarchy, not an
            EPM grouping. */}
        <ProjectHierarchyCard project={project} />

        <Card>
          <CardHeader
            variant="compact"
            actions={
              canOverrideHealth ? (
                <Button size="sm" variant="ghost" onClick={() => setHealthOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Override
                </Button>
              ) : null
            }
          >
            <CardTitle>Project health</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <ul className="space-y-3">
              {HEALTH_DIMENSIONS.map((dimension) => {
                const pinned = project.healthOverride?.[dimension.key];

                return (
                  <li key={dimension.key} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-xs font-medium">
                        {dimension.label}
                        {pinned ? (
                          <Badge tone="accent" className="text-2xs">
                            Overridden
                          </Badge>
                        ) : null}
                      </p>
                      {/* The reason names the figures the rule used, so the
                          value can be checked rather than taken on trust. */}
                      <p className="text-2xs text-muted-foreground">
                        {project.healthReasons?.[dimension.key] ?? dimension.hint}
                      </p>
                      {pinned ? (
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          Calculated: {HEALTH_META[project.healthCalculated[dimension.key]].label}
                        </p>
                      ) : null}
                    </div>
                    <HealthIndicator level={project.health[dimension.key]} className="shrink-0" />
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {canOverrideHealth ? (
          <HealthOverrideDialog
            open={healthOpen}
            onOpenChange={setHealthOpen}
            project={project}
          />
        ) : null}

        <Card>
          <CardHeader
            variant="compact"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="activity">
                  All activity
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            }
          >
            <CardTitle className="flex items-center gap-2">
              <Flag className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {/* The timeline draws its own empty state. */}
            <QueryBoundary
              isLoading={activityQuery.isLoading}
              isError={activityQuery.isError}
              error={activityQuery.error}
              onRetry={() => activityQuery.refetch()}
              errorTitle="Unable to load activity"
              skeleton={<ActivityTimelineSkeleton rows={4} />}
            >
              <ActivityTimeline entries={activityPaged.items} users={users} />
              {activityPaged.totalPages > 1 ? (
                <Pagination
                  variant="compact"
                  page={activityPaged.page}
                  pageSize={activityPaged.pageSize}
                  total={activityPaged.total}
                  onPageChange={activityPaged.setPage}
                  itemLabel="entry"
                  className="mt-3 border-t border-border px-0 pt-2"
                />
              ) : null}
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
