import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Flag,
  Gauge,
  Target,
  TrendingUp,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { BurndownChart, VelocityChart } from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { useSprints } from '@/hooks/useSprints';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useDeliveryTrends } from '@/hooks/useReports';
import { useUserMap } from '@/hooks/useUsers';
import { useUI } from '@/providers/UIProvider';
import { daysFromToday, formatShortDate, pluralize } from '@/lib/utils';
import type { ID, TaskStatusCategory } from '@/types';

/** Agile workspace: the sprint, its burndown and its board in one place. */
/**
 * How many of a sprint's work packages load at once.
 *
 * A sprint board is not a paged list — moving a card between columns needs the
 * whole set — so this loads in one go and grows on request. A sprint rarely
 * holds more than this; the notice below exists for when one does.
 */
const SPRINT_PAGE_SIZE = 200;

export default function AgilePage() {
  const { openTaskDrawer } = useUI();
  const sprintsQuery = useSprints();
  const trendsQuery = useDeliveryTrends();
  const users = useUserMap();
  const updateTask = useUpdateTask();
  const [index, setIndex] = useState<number | null>(null);

  const sprints = useMemo(() => sprintsQuery.data ?? [], [sprintsQuery.data]);

  // Land on the active sprint once the list arrives.
  useEffect(() => {
    if (index !== null || sprints.length === 0) return;
    const activeIndex = sprints.findIndex((sprint) => sprint.state === 'active');
    setIndex(activeIndex >= 0 ? activeIndex : 0);
  }, [sprints, index]);

  const sprint = index !== null ? sprints[index] : undefined;

  // Same reasoning as the board on Boards: a sprint board is not a paged list,
  // so it loads in one go and grows on request. What it must not do is show a
  // subset silently — the column counts are computed from what was fetched.
  const [pageSize, setPageSize] = useState(SPRINT_PAGE_SIZE);
  const tasksQuery = useTasks({ sprintId: sprint?.id, pageSize });
  const tasks = tasksQuery.data?.items ?? [];
  const total = tasksQuery.data?.total ?? tasks.length;
  const hidden = Math.max(0, total - tasks.length);

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success('Task moved', { description: task.key }),
        onError: () => toast.error('Unable to move the task'),
      },
    );
  };

  if (sprintsQuery.isLoading || !sprint) {
    return (
      <div className="space-y-5">
        <PageHeader title="Agile" description="Sprint delivery workspace." />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <MetricCardSkeleton key={i} />
          ))}
        </div>
        <ChartCardSkeleton height={260} />
        <KanbanBoardSkeleton columns={4} />
      </div>
    );
  }

  const progress = Math.round((sprint.completedPoints / Math.max(1, sprint.committedPoints)) * 100);
  const remaining = sprint.committedPoints - sprint.completedPoints;
  const daysLeft = daysFromToday(sprint.endDate) ?? 0;
  const velocity = trendsQuery.data ?? [];
  const averageVelocity =
    velocity.length > 0
      ? Math.round(velocity.reduce((sum, point) => sum + point.velocity, 0) / velocity.length)
      : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Delivery"
        title={sprint.name}
        description={`${formatShortDate(sprint.startDate)} — ${formatShortDate(sprint.endDate)}`}
        meta={<SprintStateBadge state={sprint.state} />}
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Previous sprint"
                disabled={index === 0}
                onClick={() => setIndex((current) => Math.max(0, (current ?? 0) - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const activeIndex = sprints.findIndex((item) => item.state === 'active');
                  setIndex(activeIndex >= 0 ? activeIndex : 0);
                }}
              >
                Current Sprint
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Next sprint"
                disabled={index === sprints.length - 1}
                onClick={() =>
                  setIndex((current) => Math.min(sprints.length - 1, (current ?? 0) + 1))
                }
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {sprint.state === 'planned' ? (
              <Button
                onClick={() =>
                  toast('Starting a sprint is not implemented yet', {
                    description: 'A connected workspace opens the sprint and locks its scope.',
                  })
                }
              >
                <CirclePlay className="h-4 w-4" />
                Start Sprint
              </Button>
            ) : sprint.state === 'active' ? (
              <Button
                onClick={() =>
                  toast('Completing a sprint is not implemented yet', {
                    description: 'Unfinished work would move to the next sprint or the backlog.',
                  })
                }
              >
                <CheckCircle2 className="h-4 w-4" />
                Complete Sprint
              </Button>
            ) : null}
          </>
        }
      />

      {/* Sprint goal */}
      <Card className="flex items-start gap-3 p-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
          aria-hidden
        >
          <Flag className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="epm-eyebrow">Sprint goal</p>
          <p className="mt-1 text-xs leading-relaxed text-foreground">{sprint.goal}</p>
        </div>
        <div className="hidden w-40 shrink-0 space-y-1.5 sm:block">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs text-muted-foreground">Progress</span>
            <span className="font-mono text-xs font-semibold tabular-nums">{progress}%</span>
          </div>
          <ProgressBar value={progress} label={`${sprint.name} progress`} />
          <p className="text-2xs text-muted-foreground">
            {daysLeft >= 0 ? `${daysLeft} days remaining` : 'Sprint window closed'}
          </p>
        </div>
      </Card>

      {/* Sprint metrics */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Committed"
          value={sprint.committedPoints}
          suffix="pts"
          support="Scope agreed at planning"
          icon={Target}
          tone="primary"
        />
        <MetricCard
          label="Completed"
          value={sprint.completedPoints}
          suffix="pts"
          support={`${progress}% of commitment`}
          icon={CheckCircle2}
          tone="success"
        />
        <MetricCard
          label="Remaining"
          value={remaining}
          suffix="pts"
          support={daysLeft >= 0 ? `${daysLeft} days left` : 'Past the end date'}
          icon={Gauge}
          tone={remaining > 0 && daysLeft <= 2 ? 'warning' : 'accent'}
        />
        <MetricCard
          label="Velocity"
          value={averageVelocity}
          suffix="pts"
          support="Rolling average per sprint"
          icon={TrendingUp}
          tone="highlight"
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Burndown" description="Remaining points vs. the ideal line" height={260}>
          <BurndownChart data={sprint.burndown} />
        </ChartCard>

        {trendsQuery.isLoading ? (
          <ChartCardSkeleton height={260} />
        ) : (
          <ChartCard title="Velocity" description="Story points delivered per sprint" height={260}>
            <VelocityChart data={velocity} />
          </ChartCard>
        )}
      </div>

      {/* Sprint board */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Sprint board</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Work committed to {sprint.name} across every project
            </p>
          </div>
        </div>

        <QueryBoundary
          isLoading={tasksQuery.isLoading}
          isError={tasksQuery.isError}
          error={tasksQuery.error}
          onRetry={() => tasksQuery.refetch()}
          errorTitle="Unable to load sprint work"
          skeleton={<KanbanBoardSkeleton columns={4} />}
          isEmpty={tasks.length === 0}
          empty={
            <Card>
              <EmptyState
                icon={Target}
                title="No work in this sprint"
                description="Commit work packages from the backlog to plan this sprint."
                action={{
                  label: 'Create a task',
                  onClick: () => openTaskDrawer({ sprintId: sprint.id }),
                }}
              />
            </Card>
          }
        >
          <div className="space-y-3">
            <KanbanBoard
              tasks={tasks}
              users={users}
              onStatusChange={handleStatusChange}
              onCreate={(status) => openTaskDrawer({ status, sprintId: sprint.id })}
              columns={['todo', 'in_progress', 'review', 'done']}
            />

            {/* Only when the board is showing a subset. A sprint rarely holds
                more than this, so the normal case is silence. */}
            {hidden > 0 ? (
              <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <p className="text-2xs text-muted-foreground">
                  Showing <span className="font-medium text-foreground">{tasks.length}</span> of{' '}
                  <span className="font-medium text-foreground">{total}</span>{' '}
                  {pluralize(total, 'task')}. The column counts cover what is loaded.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tasksQuery.isFetching}
                  onClick={() => setPageSize((size) => size + SPRINT_PAGE_SIZE)}
                >
                  {tasksQuery.isFetching
                    ? 'Loading…'
                    : `Load ${Math.min(hidden, SPRINT_PAGE_SIZE)} more`}
                </Button>
              </Card>
            ) : null}
          </div>
        </QueryBoundary>
      </section>
    </div>
  );
}
