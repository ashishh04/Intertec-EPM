import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowRight,
  CircleDot,
  FolderKanban,
  ListTodo,
  Plus,
  Target,
} from 'lucide-react';
import { PageHeader, SectionHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ProjectCardSkeleton, ProjectHealthCard } from '@/components/common/ProjectCard';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import { SprintSummary, SprintSummaryEmpty, SprintSummarySkeleton } from '@/components/dashboard/SprintSummary';
import { DeliveryTrendChart } from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboardMetrics, useActivity } from '@/hooks/useDashboard';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { useActiveSprint } from '@/hooks/useSprints';
import { useDeliveryTrends } from '@/hooks/useReports';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { formatLongDate, formatNumber, greetingForHour, pluralize } from '@/lib/utils';
import type { ID, EpmProject, TaskFilters } from '@/types';

const WORK_TABS: { value: NonNullable<TaskFilters['bucket']>; label: string }[] = [
  // "All" means all open work — completed items have their own tab.
  { value: 'open', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'completed', label: 'Completed' },
];

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } },
};

const rise = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.32, 0.72, 0, 1] as const } },
};

/**
 * Primary operational surface. Ordered so the most actionable information —
 * what is mine, what is late — sits above the analytics.
 */
export default function DashboardPage() {
  const { user } = useAuth();
  const { openTaskDrawer } = useUI();
  const navigate = useNavigate();
  const [bucket, setBucket] = useState<NonNullable<TaskFilters['bucket']>>('open');

  const metricsQuery = useDashboardMetrics();
  const projectsQuery = useProjects();
  const activityQuery = useActivity({ limit: 8 });
  const sprintQuery = useActiveSprint();
  const trendsQuery = useDeliveryTrends();
  const users = useUserMap();

  const myWorkQuery = useTasks({
    assigneeId: user?.id,
    bucket,
    pageSize: 6,
    sortBy: 'dueDate',
    sortDir: 'asc',
  });

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  // Projects that need attention first, then the rest by progress.
  const rankedProjects = useMemo(() => {
    const rank = { delayed: 0, at_risk: 1, on_track: 2, paused: 3, completed: 4 } as const;
    return [...(projectsQuery.data ?? [])]
      .sort((a, b) => rank[a.status] - rank[b.status] || b.progress - a.progress)
      .slice(0, 6);
  }, [projectsQuery.data]);

  const metrics = metricsQuery.data;

  return (
    <div className="space-y-7">
      {/* 1 — Greeting and global actions */}
      <PageHeader
        title={`${greetingForHour()}, ${user?.name?.split(' ')[0] ?? 'there'}.`}
        description="Here's what needs your attention today."
        actions={
          <>
            <div className="hidden text-right sm:block">
              <p className="epm-eyebrow">Today</p>
              <p className="font-mono text-xs font-medium text-foreground">
                {formatLongDate(new Date())}
              </p>
            </div>
            <Button onClick={() => openTaskDrawer()}>
              <Plus className="h-4 w-4" />
              Create
            </Button>
          </>
        }
      />

      {/* 2 — KPI summary */}
      <motion.section
        variants={stagger}
        initial="hidden"
        animate="show"
        aria-label="Key metrics"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {metricsQuery.isLoading || !metrics
          ? [0, 1, 2, 3].map((index) => <MetricCardSkeleton key={index} />)
          : [
              {
                label: 'My Tasks',
                value: metrics.myTasks,
                support: `${formatNumber(metrics.myTasksDueThisWeek)} due this week`,
                icon: ListTodo,
                tone: 'primary' as const,
                trend: metrics.trends.myTasks,
                onClick: () => navigate('/my-work'),
              },
              {
                label: 'In Progress',
                value: metrics.inProgress,
                support:
                  metrics.inProgressBlocked > 0
                    ? `${formatNumber(metrics.inProgressBlocked)} blocked`
                    : 'Nothing blocked',
                icon: CircleDot,
                tone: 'accent' as const,
                trend: metrics.trends.inProgress,
                onClick: () => navigate('/tasks?status=in_progress'),
              },
              {
                label: 'Overdue',
                value: metrics.overdue,
                support:
                  metrics.overdueCritical > 0
                    ? `${formatNumber(metrics.overdueCritical)} critical`
                    : 'No critical items',
                icon: AlertTriangle,
                tone: 'danger' as const,
                trend: metrics.trends.overdue,
                onClick: () => navigate('/my-work?bucket=overdue'),
              },
              {
                label: 'Active Projects',
                value: metrics.activeProjects,
                support: `${formatNumber(metrics.projectsAtRisk)} ${pluralize(metrics.projectsAtRisk, 'project')} at risk`,
                icon: FolderKanban,
                tone: 'highlight' as const,
                trend: metrics.trends.activeProjects,
                onClick: () => navigate('/projects'),
              },
            ].map((card) => (
              <motion.div key={card.label} variants={rise}>
                <MetricCard {...card} />
              </motion.div>
            ))}
      </motion.section>

      {/* 3 — My Work and sprint progress */}
      <section className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            variant="compact"
            actions={
              <Tabs value={bucket} onValueChange={(value) => setBucket(value as typeof bucket)}>
                <TabsList>
                  {WORK_TABS.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            }
          >
            <CardTitle>My Work</CardTitle>
            <CardDescription className="text-2xs">
              Assigned to you across every active project
            </CardDescription>
          </CardHeader>

          <QueryBoundary
            isLoading={myWorkQuery.isLoading}
            isError={myWorkQuery.isError}
            error={myWorkQuery.error}
            onRetry={() => myWorkQuery.refetch()}
            errorTitle="Unable to load your work"
            skeleton={<TaskListSkeleton rows={5} />}
            isEmpty={(myWorkQuery.data?.items.length ?? 0) === 0}
            empty={
              <EmptyState
                size="inline"
                icon={Target}
                title={bucket === 'overdue' ? 'Nothing is overdue' : 'No tasks found'}
                description={
                  bucket === 'completed'
                    ? 'Completed work will appear here once you close items.'
                    : 'Your work queue is clear.'
                }
                action={{ label: 'Create a task', onClick: () => openTaskDrawer() }}
              />
            }
          >
            <div className="divide-y divide-border">
              {myWorkQuery.data?.items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  project={projectsById.get(task.projectId)}
                  assignee={task.assigneeId ? users.get(task.assigneeId) : undefined}
                />
              ))}
            </div>
          </QueryBoundary>

          <div className="border-t border-border px-4 py-2.5">
            <Button asChild variant="ghost" size="sm" className="text-2xs">
              <Link to="/my-work">
                View all my work
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </Card>

        {/* 5 — Sprint progress */}
        {/* Three states, not two: loading, a running sprint, and no sprint at
            all. Collapsing the last two into the skeleton left the card
            loading forever whenever nothing was in flight. */}
        {sprintQuery.isPending ? (
          <SprintSummarySkeleton />
        ) : sprintQuery.data ? (
          <SprintSummary sprint={sprintQuery.data} />
        ) : (
          <SprintSummaryEmpty />
        )}
      </section>

      {/* 4 — Project health */}
      <section className="space-y-3">
        <SectionHeader
          title="Project Health"
          description="Delivery status across the active portfolio"
          actions={
            <Button asChild variant="ghost" size="sm" className="text-2xs">
              <Link to="/projects">
                View all
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          }
        />

        <QueryBoundary
          isLoading={projectsQuery.isLoading}
          isError={projectsQuery.isError}
          error={projectsQuery.error}
          onRetry={() => projectsQuery.refetch()}
          errorTitle="Unable to load projects"
          skeleton={
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <ProjectCardSkeleton key={index} />
              ))}
            </div>
          }
          isEmpty={rankedProjects.length === 0}
          empty={
            <Card>
              <EmptyState
                icon={FolderKanban}
                title="No projects yet"
                description="Projects sync from the delivery workspace once they are provisioned."
              />
            </Card>
          }
        >
          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {rankedProjects.map((project) => (
              <motion.div key={project.id} variants={rise}>
                <ProjectHealthCard project={project} users={users} />
              </motion.div>
            ))}
          </motion.div>
        </QueryBoundary>
      </section>

      {/* 6 and 7 — Delivery trends and recent activity */}
      <section className="grid gap-5 lg:grid-cols-3">
        <QueryBoundary
          isLoading={trendsQuery.isLoading}
          isError={trendsQuery.isError}
          error={trendsQuery.error}
          onRetry={() => trendsQuery.refetch()}
          errorTitle="Unable to load delivery insights"
          skeleton={<ChartCardSkeleton height={260} className="lg:col-span-2" />}
        >
          <ChartCard
            title="Delivery Insights"
            description="Completed vs. created work packages per sprint"
            className="lg:col-span-2"
            height={260}
            actions={
              <Button asChild variant="ghost" size="sm" className="text-2xs">
                <Link to="/analytics">Details</Link>
              </Button>
            }
          >
            <DeliveryTrendChart data={trendsQuery.data ?? []} />
          </ChartCard>
        </QueryBoundary>

        <Card>
          <CardHeader variant="compact">
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription className="text-2xs">
              Latest changes across your projects
            </CardDescription>
          </CardHeader>
          <div className="p-4">
            <QueryBoundary
              isLoading={activityQuery.isLoading}
              isError={activityQuery.isError}
              error={activityQuery.error}
              onRetry={() => activityQuery.refetch()}
              errorTitle="Unable to load activity"
              skeleton={<ActivityTimelineSkeleton />}
            >
              <ActivityTimeline entries={activityQuery.data ?? []} users={users} limit={7} />
            </QueryBoundary>
          </div>
        </Card>
      </section>
    </div>
  );
}
