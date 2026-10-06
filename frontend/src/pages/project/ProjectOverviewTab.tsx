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
import { ProjectHealthCard } from '@/components/projects/ProjectHealthCard';
import { ProjectPlanDialog } from '@/components/projects/ProjectPlanDialog';
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
import { PriorityBadge } from '@/components/common/StatusBadge';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useProject, useProjectMilestones } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { PROJECT_STATUS_META, TONE_FILL } from '@/lib/domain';
import {
  cn,
  formatCurrency,
  formatLongDate,
  formatNumber,
  formatPercent,
  formatShortDate,
  pluralize,
} from '@/lib/utils';

/** Sentinel: a select cannot hold an empty string as a value. */
const NO_OWNER = '__none__';

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
  const { canInProject } = useAuth();
  const [planOpen, setPlanOpen] = useState(false);
  const setOwner = useSetProjectOwner();
  const canEditProject = canInProject(project?.id, 'project:edit');

  // Whoever is on the project. Owning a project you have no access to would be
  // a title without the ability to act on it.
  const memberOptions = (project?.memberIds ?? [])
    .map((id) => users.get(id))
    .filter((user): user is NonNullable<typeof user> => Boolean(user))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (isLoading || !project) {
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const owner = users.get(project.ownerId);
  // Not assessed means the instance has no risk type to count.
  const risksTracked =
    project.healthDetail.criteria.find((criterion) => criterion.criterion === 'risks')?.level !== null;
  const budgetPct =
    project.budgetTotal > 0 ? Math.round((project.budgetUsed / project.budgetTotal) * 100) : null;
  // Days the open work is forecast to finish after the planned finish.
  const slip =
    project.dueDate && project.forecastFinish
      ? Math.round(
          (Date.parse(`${project.forecastFinish.slice(0, 10)}T00:00:00Z`) -
            Date.parse(`${project.dueDate.slice(0, 10)}T00:00:00Z`)) /
            86_400_000,
        )
      : null;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {/* Summary */}
        <Card>
          <CardHeader
            variant="compact"
            actions={
              canEditProject ? (
                <Button size="sm" variant="ghost" onClick={() => setPlanOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Plan and budget
                </Button>
              ) : null
            }
          >
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
                <dt className="epm-eyebrow">Planned start</dt>
                <dd className="mt-1 font-mono text-xs tabular-nums">
                  {project.startDate ? formatLongDate(project.startDate) : 'Not set'}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Planned finish</dt>
                <dd className="mt-1 font-mono text-xs tabular-nums">
                  {project.dueDate ? formatLongDate(project.dueDate) : 'Not set'}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Forecast finish</dt>
                <dd className="mt-1 text-xs">
                  {/* From the open work's own dates: the latest due date, and
                      never before today while anything is overdue. */}
                  <span className="font-mono tabular-nums">
                    {project.forecastFinish ? formatLongDate(project.forecastFinish) : '—'}
                  </span>
                  {slip !== null && slip !== 0 ? (
                    <span
                      className={cn(
                        'ml-1.5 text-2xs font-medium',
                        slip > 0 ? 'text-danger' : 'text-success',
                      )}
                    >
                      {slip > 0 ? `${slip} ${pluralize(slip, 'day')} late` : `${-slip} ${pluralize(-slip, 'day')} early`}
                    </span>
                  ) : null}
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
                  {/* Work packages of a risk type. With no such type on the
                      instance there is nothing to count, which is said rather
                      than shown as a reassuring zero. */}
                  {risksTracked ? (
                    <>
                      <ShieldAlert
                        className={cn(
                          'h-3.5 w-3.5',
                          project.openRiskCount === 0
                            ? 'text-muted-foreground'
                            : project.openRiskCount > 2
                              ? 'text-danger'
                              : 'text-warning',
                        )}
                        aria-hidden
                      />
                      {formatNumber(project.openRiskCount)}
                    </>
                  ) : (
                    <span className="font-normal text-muted-foreground">Not tracked</span>
                  )}
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
                label="Planned finish"
                value={project.dueDate ? formatShortDate(project.dueDate) : 'Not set'}
              />
              <SummaryStat
                icon={Users}
                label="Team size"
                value={`${formatNumber(project.memberIds.length)} ${pluralize(project.memberIds.length, 'member')}`}
              />
              <SummaryStat
                icon={CircleDollarSign}
                label="Spent to date"
                value={
                  project.budgetTotal > 0
                    ? `${formatCurrency(project.budgetUsed)} of ${formatCurrency(project.budgetTotal)}`
                    : formatCurrency(project.budgetUsed)
                }
                sub={
                  // Spend is logged hours at each person's rate; hours from
                  // someone with no rate are said, not priced at zero.
                  [
                    budgetPct === null ? 'No budget set' : `${formatPercent(budgetPct)} of budget`,
                    project.uncostedHours > 0
                      ? `${formatNumber(project.uncostedHours)} ${pluralize(project.uncostedHours, 'hour')} not costed`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                }
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

        <ProjectHealthCard project={project} />

        {canEditProject ? (
          <ProjectPlanDialog open={planOpen} onOpenChange={setPlanOpen} project={project} />
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
