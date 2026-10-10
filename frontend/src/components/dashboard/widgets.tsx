import { Suspense, lazy, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  CircleDot,
  Clock,
  Eye,
  FolderKanban,
  Gauge,
  ListTodo,
  PenLine,
  Target,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { addDays, startOfWeek } from 'date-fns';

import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { EmptyState } from '@/components/common/EmptyState';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { NotificationItem } from '@/components/common/NotificationItem';
import { ProjectCardSkeleton, ProjectHealthCard } from '@/components/common/ProjectCard';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { SectionHeader } from '@/components/common/PageHeader';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import {
  SprintSummary,
  SprintSummaryEmpty,
  SprintSummarySkeleton,
} from '@/components/dashboard/SprintSummary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useActivity, useCalendarEvents, useDashboardMetrics } from '@/hooks/useDashboard';
import { useEmployee } from '@/hooks/useEmployees';
import { useNotifications } from '@/hooks/useNotifications';
import { useProjects } from '@/hooks/useProjects';
import { useDeliveryTrends } from '@/hooks/useReports';
import { useActiveSprint } from '@/hooks/useSprints';
import { useTasks } from '@/hooks/useTasks';
import { useTimeEntries } from '@/hooks/useTimeEntries';
import { useUserMap } from '@/hooks/useUsers';
import { usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import {
  formatHours,
  formatShortDate,
  toISODateOnly,
} from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { DashboardWidgetWidth, EpmProject, ID } from '@/types';

/**
 * The Overview widget catalogue.
 *
 * Each widget is a self-contained component that fetches what it needs. That is
 * the whole design: a person who removes "Delivery Insights" should stop paying
 * for the request behind it, and a widget that is not on the page must not be
 * mounted at all. Lifting the queries into the page would have made every
 * layout cost the same as the fullest one.
 *
 * Ids are stable strings and are what a saved layout stores. Renaming one
 * silently drops it from every layout that used it, so don't — retire it from
 * `WIDGETS` and the layouts skip it on render instead.
 */

export interface DashboardWidget {
  id: string;
  title: string;
  /** Shown in the picker, not on the widget. One line on what it answers. */
  description: string;
  icon: LucideIcon;
  /** Width when the layout does not override it. */
  defaultWidth: DashboardWidgetWidth;
  /** True when the widget can usefully be either width. */
  resizable?: boolean;
  Component: () => JSX.Element;
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A list of work packages, which four widgets are variations on.
 *
 * The filter is the only thing that differs between "assigned to me", "I
 * raised", "I watch" and "mine and overdue", so it is the only thing passed in.
 */
function TaskListWidget({
  title,
  description,
  filters,
  linkTo,
  linkLabel,
  emptyTitle,
  emptyDescription,
  emptyIcon = Target,
}: {
  title: string;
  description: string;
  filters: Parameters<typeof useTasks>[0];
  linkTo: string;
  linkLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon?: LucideIcon;
}) {
  const query = useTasks(filters, { enabled: Boolean(filters?.assigneeId ?? filters?.authorId ?? filters?.watcherId) });
  const projectsQuery = useProjects();
  const users = useUserMap();

  const projectsById = useMemo(
    () =>
      new Map<ID, EpmProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  return (
    <Card className="flex flex-col">
      <CardHeader variant="compact">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-2xs">{description}</CardDescription>
      </CardHeader>

      <div className="flex-1">
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
          errorTitle={t('Unable to load {title}', { title: title.toLowerCase() })}
          skeleton={<TaskListSkeleton rows={4} />}
          isEmpty={(query.data?.items.length ?? 0) === 0}
          empty={
            <EmptyState
              size="inline"
              icon={emptyIcon}
              title={emptyTitle}
              description={emptyDescription}
            />
          }
        >
          <div className="divide-y divide-border">
            {query.data?.items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                project={projectsById.get(task.projectId)}
                assignee={task.assigneeId ? users.get(task.assigneeId) : undefined}
              />
            ))}
          </div>
        </QueryBoundary>
      </div>

      <div className="border-t border-border px-4 py-2.5">
        <Button asChild variant="ghost" size="sm" className="text-2xs">
          <Link to={linkTo}>
            {linkLabel}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

function KpiWidget() {
  const navigate = useNavigate();
  const query = useDashboardMetrics();
  const metrics = query.data;

  if (query.isLoading || !metrics) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <MetricCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label={t('My Tasks')}
        value={metrics.myTasks}
        support={t('{count, number} due this week', { count: metrics.myTasksDueThisWeek })}
        icon={ListTodo}
        tone="primary"
        trend={metrics.trends.myTasks}
        onClick={() => navigate('/my-work')}
      />
      <MetricCard
        label={t('In Progress')}
        value={metrics.inProgress}
        support={
          metrics.inProgressBlocked > 0
            ? t('{count, number} blocked', { count: metrics.inProgressBlocked })
            : t('Nothing blocked')
        }
        icon={CircleDot}
        tone="accent"
        trend={metrics.trends.inProgress}
        onClick={() => navigate('/tasks?status=in_progress')}
      />
      <MetricCard
        label={t('Overdue')}
        value={metrics.overdue}
        support={
          metrics.overdueCritical > 0
            ? t('{count, number} critical', { count: metrics.overdueCritical })
            : t('No critical items')
        }
        icon={AlertTriangle}
        tone="danger"
        trend={metrics.trends.overdue}
        onClick={() => navigate('/my-work?bucket=overdue')}
      />
      <MetricCard
        label={t('Active Projects')}
        value={metrics.activeProjects}
        support={t('{count, plural, one {# project at risk} other {# projects at risk}}', { count: metrics.projectsAtRisk })}
        icon={FolderKanban}
        tone="highlight"
        trend={metrics.trends.activeProjects}
        onClick={() => navigate('/projects')}
      />
    </div>
  );
}

function MyWorkWidget() {
  const { user } = useAuth();
  return (
    <TaskListWidget
      title={t('My Work')}
      description={t('Assigned to you across every active project')}
      filters={{ assigneeId: user?.id, bucket: 'open', pageSize: 6, sortBy: 'dueDate', sortDir: 'asc' }}
      linkTo="/my-work"
      linkLabel={t('View all my work')}
      emptyTitle={t('No tasks assigned')}
      emptyDescription={t('Your work queue is clear.')}
    />
  );
}

function CreatedByMeWidget() {
  const { user } = useAuth();
  return (
    <TaskListWidget
      title={t('Created by me')}
      description={t('Work you raised, whoever is carrying it')}
      filters={{ authorId: user?.id, bucket: 'open', pageSize: 6, sortBy: 'updatedAt', sortDir: 'desc' }}
      linkTo="/tasks"
      linkLabel={t('Open the task list')}
      emptyTitle={t('Nothing raised by you is open')}
      emptyDescription={t('Work you create will appear here until it closes.')}
      emptyIcon={PenLine}
    />
  );
}

function WatchingWidget() {
  const { user } = useAuth();
  return (
    <TaskListWidget
      title={t('Watching')}
      description={t('Work you are following without owning')}
      filters={{ watcherId: user?.id, bucket: 'open', pageSize: 6, sortBy: 'updatedAt', sortDir: 'desc' }}
      linkTo="/tasks"
      linkLabel={t('Open the task list')}
      emptyTitle={t('You are not watching anything')}
      emptyDescription={t('Watch a task from its page to follow it here.')}
      emptyIcon={Eye}
    />
  );
}

function MyOverdueWidget() {
  const { user } = useAuth();
  return (
    <TaskListWidget
      title={t('Overdue')}
      description={t('Yours, past its due date and still open')}
      filters={{ assigneeId: user?.id, bucket: 'overdue', pageSize: 6, sortBy: 'dueDate', sortDir: 'asc' }}
      linkTo="/my-work?bucket=overdue"
      linkLabel={t('Review everything overdue')}
      emptyTitle={t('Nothing is overdue')}
      emptyDescription={t('Every open item of yours is still within its date.')}
      emptyIcon={AlertTriangle}
    />
  );
}

function SprintWidget() {
  const query = useActiveSprint();

  // Three states, not two: loading, a running sprint, and no sprint at all.
  // Collapsing the last two into the skeleton left the card loading forever
  // whenever nothing was in flight.
  if (query.isPending) return <SprintSummarySkeleton />;
  return query.data ? <SprintSummary sprint={query.data} /> : <SprintSummaryEmpty />;
}

function ProjectHealthWidget() {
  const query = useProjects();
  const users = useUserMap();

  // Projects that need attention first, then the rest by progress.
  const ranked = useMemo(() => {
    const rank = { delayed: 0, at_risk: 1, on_track: 2, paused: 3, completed: 4 } as const;
    return [...(query.data ?? [])]
      .sort((a, b) => rank[a.status] - rank[b.status] || b.progress - a.progress)
      .slice(0, 6);
  }, [query.data]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t('Project Health')}
        description={t('Delivery status across the active portfolio')}
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to="/projects">
              {t('View all')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      />

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load projects')}
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <ProjectCardSkeleton key={index} />
            ))}
          </div>
        }
        isEmpty={ranked.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={FolderKanban}
              title={t('No projects yet')}
              description={t('Projects sync from the delivery workspace once they are provisioned.')}
            />
          </Card>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ranked.map((project) => (
            <ProjectHealthCard key={project.id} project={project} users={users} />
          ))}
        </div>
      </QueryBoundary>
    </div>
  );
}

/*
 * Recharts, loaded only if a chart widget is actually on the page.
 *
 * The charting library is the largest dependency in the bundle by a wide margin —
 * more than the whole of React — and importing it here statically would put it in
 * the Overview's critical path for everybody, including the people who removed
 * every chart from their layout. That would have made customising the dashboard
 * cheaper in requests and no cheaper at all to load, which rather defeats it.
 *
 * `Suspense` inside the widget rather than around the grid, so one chart still
 * loading never blanks the widgets beside it.
 */
const DeliveryTrendChart = lazy(() =>
  import('@/components/charts/EpmCharts').then((module) => ({
    default: module.DeliveryTrendChart,
  })),
);

function DeliveryTrendsWidget() {
  const query = useDeliveryTrends();

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => query.refetch()}
      errorTitle={t('Unable to load delivery insights')}
      skeleton={<ChartCardSkeleton height={260} />}
    >
      <ChartCard
        title={t('Delivery Insights')}
        description={t('Delivered and created work packages per month')}
        height={260}
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to="/analytics">{t('Details')}</Link>
          </Button>
        }
      >
        <Suspense fallback={null}>
          <DeliveryTrendChart data={query.data ?? []} />
        </Suspense>
      </ChartCard>
    </QueryBoundary>
  );
}

function ActivityWidget() {
  const query = useActivity({ limit: 8 });
  const users = useUserMap();

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Recent Activity')}</CardTitle>
        <CardDescription className="text-2xs">{t('Latest changes across your projects')}</CardDescription>
      </CardHeader>
      <div className="p-4">
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
          errorTitle={t('Unable to load activity')}
          skeleton={<ActivityTimelineSkeleton />}
        >
          <ActivityTimeline entries={query.data ?? []} users={users} limit={7} />
        </QueryBoundary>
      </div>
    </Card>
  );
}

/**
 * Hours logged this week against contracted capacity.
 *
 * The same figure My time tracking opens on, so the two cannot disagree: the
 * week boundary comes from the person's own preference and capacity from their
 * employee record, exactly as it does there.
 */
function TimeThisWeekWidget() {
  const { user } = useAuth();
  const { preferences } = usePreferences();

  const weekStartsOn = preferences.workweek.startOfWeek === 'sunday' ? 0 : 1;
  const weekStart = startOfWeek(new Date(), { weekStartsOn });
  const from = toISODateOnly(weekStart);
  const to = toISODateOnly(addDays(weekStart, 6));

  // `me`, for the same reason My time tracking uses it: a numeric id in this
  // filter is refused for anybody who belongs to no project.
  const entriesQuery = useTimeEntries({ userId: 'me', from, to, pageSize: 200 });
  const profile = useEmployee(user?.id);

  const entries = entriesQuery.data?.items ?? [];
  const logged = entries.reduce((sum, entry) => sum + entry.hours, 0);
  const capacity = profile.data?.hoursCapacity ?? 0;

  return (
    <Card className="flex flex-col">
      <CardHeader
        variant="compact"
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to="/my-time">
              {t('Timesheet')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <CardTitle>{t('This week')}</CardTitle>
        <CardDescription className="text-2xs">
          {t('{from} to {to}', { from: formatShortDate(weekStart), to: formatShortDate(addDays(weekStart, 6)) })}
        </CardDescription>
      </CardHeader>

      <div className="flex-1 space-y-3 p-4">
        {entriesQuery.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-2xl font-bold tracking-[-0.03em]">
                {formatHours(logged)}
              </span>
              {capacity > 0 ? (
                <span className="text-2xs text-muted-foreground">{t('of {hours}', { hours: formatHours(capacity) })}</span>
              ) : null}
            </div>

            {capacity > 0 ? (
              <ProgressBar
                value={Math.min(100, Math.round((logged / capacity) * 100))}
                tone={logged > capacity ? 'warning' : logged >= capacity ? 'success' : 'primary'}
                label={t('Hours logged this week')}
              />
            ) : (
              <p className="text-2xs text-muted-foreground">
                {t('No weekly capacity is set for you, so there is nothing to measure against.')}
              </p>
            )}

            <p className="text-2xs text-muted-foreground">
              {entries.length === 0
                ? t('Nothing logged yet this week.')
                : t('{entries, plural, one {# entry} other {# entries}} across {days, plural, one {# day} other {# days}}.', {
                    entries: entries.length,
                    days: new Set(entries.map((entry) => entry.spentOn)).size,
                  })}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/** Milestones and dated work in the next fortnight. */
function UpcomingWidget() {
  const range = useMemo(() => {
    const today = new Date();
    return { from: toISODateOnly(today), to: toISODateOnly(addDays(today, 14)) };
  }, []);

  const query = useCalendarEvents(range);
  const events = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8),
    [query.data],
  );

  return (
    <Card className="flex flex-col">
      <CardHeader
        variant="compact"
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to="/calendar">
              {t('Calendar')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <CardTitle>{t('Coming up')}</CardTitle>
        <CardDescription className="text-2xs">{t('Dated work over the next fortnight')}</CardDescription>
      </CardHeader>

      <div className="flex-1">
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
          errorTitle={t('Unable to load the calendar')}
          skeleton={<TaskListSkeleton rows={4} />}
          isEmpty={events.length === 0}
          empty={
            <EmptyState
              size="inline"
              icon={CalendarClock}
              title={t('Nothing dated in the next fortnight')}
              description={t('Milestones and due dates appear here as they approach.')}
            />
          }
        >
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-14 shrink-0 text-2xs text-muted-foreground">
                  {formatShortDate(event.date)}
                </div>
                <div className="min-w-0 flex-1">
                  {event.taskId ? (
                    <Link
                      to={`/tasks/${event.taskId}`}
                      className="block truncate text-xs hover:underline"
                      dir="auto"
                    >
                      {event.title}
                    </Link>
                  ) : (
                    <p className="truncate text-xs" dir="auto">{event.title}</p>
                  )}
                </div>
                {event.kind === 'milestone' ? (
                  <Badge tone="highlight" size="sm">
                    {t('Milestone')}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </div>
    </Card>
  );
}

function NotificationsWidget() {
  const query = useNotifications();
  const users = useUserMap();
  const latest = (query.data ?? []).slice(0, 6);

  return (
    <Card className="flex flex-col">
      <CardHeader
        variant="compact"
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to="/notifications">
              {t('All alerts')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <CardTitle>{t('Alerts')}</CardTitle>
        <CardDescription className="text-2xs">{t('The most recent first')}</CardDescription>
      </CardHeader>

      <div className="flex-1">
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          onRetry={() => query.refetch()}
          errorTitle={t('Unable to load alerts')}
          skeleton={<TaskListSkeleton rows={4} />}
          isEmpty={latest.length === 0}
          empty={
            <EmptyState
              size="inline"
              icon={Bell}
              title={t('Nothing to catch up on')}
              description={t('Mentions, assignments and reminders land here.')}
            />
          }
        >
          <div className="divide-y divide-border">
            {latest.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                users={users}
                compact
              />
            ))}
          </div>
        </QueryBoundary>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export const WIDGETS: DashboardWidget[] = [
  {
    id: 'kpis',
    get title() { return t('Key metrics'); },
    get description() { return t('My tasks, in progress, overdue and active projects, with their weekly trend.'); },
    icon: Gauge,
    defaultWidth: 'full',
    Component: KpiWidget,
  },
  {
    id: 'my-work',
    get title() { return t('My Work'); },
    get description() { return t('Open work assigned to you, soonest due first.'); },
    icon: ListTodo,
    defaultWidth: 'full',
    resizable: true,
    Component: MyWorkWidget,
  },
  {
    id: 'created-by-me',
    get title() { return t('Created by me'); },
    get description() { return t('Open work you raised, whoever is carrying it now.'); },
    icon: PenLine,
    defaultWidth: 'half',
    resizable: true,
    Component: CreatedByMeWidget,
  },
  {
    id: 'watching',
    get title() { return t('Watching'); },
    get description() { return t('Open work you follow without owning.'); },
    icon: Eye,
    defaultWidth: 'half',
    resizable: true,
    Component: WatchingWidget,
  },
  {
    id: 'my-overdue',
    get title() { return t('Overdue'); },
    get description() { return t('Your open work that is past its due date.'); },
    icon: AlertTriangle,
    defaultWidth: 'half',
    resizable: true,
    Component: MyOverdueWidget,
  },
  {
    id: 'sprint',
    get title() { return t('Active sprint'); },
    get description() { return t('Burndown, scope and days remaining on the sprint in flight.'); },
    icon: Target,
    defaultWidth: 'half',
    Component: SprintWidget,
  },
  {
    id: 'time-this-week',
    get title() { return t('Time this week'); },
    get description() { return t('Hours you have logged this week against your contracted capacity.'); },
    icon: Clock,
    defaultWidth: 'half',
    resizable: true,
    Component: TimeThisWeekWidget,
  },
  {
    id: 'project-health',
    get title() { return t('Project health'); },
    get description() { return t('Health cards for the projects that need attention first.'); },
    icon: FolderKanban,
    defaultWidth: 'full',
    Component: ProjectHealthWidget,
  },
  {
    id: 'delivery-trends',
    get title() { return t('Delivery insights'); },
    get description() { return t('Completed against created work packages, sprint by sprint.'); },
    icon: TrendingUp,
    defaultWidth: 'full',
    resizable: true,
    Component: DeliveryTrendsWidget,
  },
  {
    id: 'activity',
    get title() { return t('Recent activity'); },
    get description() { return t('The latest changes across the projects you can see.'); },
    icon: Activity,
    defaultWidth: 'half',
    resizable: true,
    Component: ActivityWidget,
  },
  {
    id: 'upcoming',
    get title() { return t('Coming up'); },
    get description() { return t('Milestones and due dates over the next fortnight.'); },
    icon: CalendarClock,
    defaultWidth: 'half',
    resizable: true,
    Component: UpcomingWidget,
  },
  {
    id: 'notifications',
    get title() { return t('Alerts'); },
    get description() { return t('Your most recent mentions, assignments and reminders.'); },
    icon: Bell,
    defaultWidth: 'half',
    resizable: true,
    Component: NotificationsWidget,
  },
];

/** Catalogue by id, for resolving a saved layout. */
export const WIDGETS_BY_ID = new Map(WIDGETS.map((widget) => [widget.id, widget]));

/**
 * A quick-add widget for the floating action button and the empty state.
 *
 * Not the catalogue order: these are the ones worth suggesting to someone who
 * has just emptied their Overview.
 */
export const SUGGESTED_WIDGET_IDS = ['kpis', 'my-work', 'project-health', 'activity'];
