import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, CirclePlay, Flag, Gauge, Plus, Target, Timer, TrendingUp } from 'lucide-react';
import { PageHeader, SectionHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { SprintWorkList } from '@/components/sprints/SprintWorkList';
import { SprintDialog } from '@/components/sprints/SprintDialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { BurndownChart, VelocityChart } from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ProgressBar } from '@/components/ui/progress';
import { useSetSprintState, useSprints } from '@/hooks/useSprints';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useDeliveryTrends } from '@/hooks/useReports';
import { useUserMap } from '@/hooks/useUsers';
import { useUI } from '@/providers/UIProvider';
import { SPRINT_STATE_META } from '@/lib/domain';
import { daysFromToday, formatNumber, formatPercent, formatShortDate, pluralize } from '@/lib/utils';
import type { EpmSprint, ID, SprintState, TaskStatusCategory } from '@/types';

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
  const setSprintState = useSetSprintState();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [confirming, setConfirming] = useState<SprintState | null>(null);

  // Active sprints first, then what is planned, then history, newest first.
  const sprints = useMemo(() => {
    const rank: Record<SprintState, number> = { active: 0, planned: 1, completed: 2 };
    return [...(sprintsQuery.data ?? [])].sort(
      (a, b) => rank[a.state] - rank[b.state] || b.startDate.localeCompare(a.startDate),
    );
  }, [sprintsQuery.data]);

  // The selection lives in the URL, so a sprint opened from the Sprints page,
  // or one just created, is the one shown — and a refresh keeps it.
  const selectedId = searchParams.get('sprint');
  const activeSprint = sprints.find((item) => item.state === 'active');
  const sprint: EpmSprint | undefined =
    sprints.find((item) => item.id === selectedId) ?? activeSprint ?? sprints[0];

  const selectSprint = (id: ID) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('sprint', id);
      return next;
    });
  };

  // Once the list is in, pin the default choice into the address bar so the
  // selector, the URL and the page agree.
  useEffect(() => {
    if (sprint && sprint.id !== selectedId) selectSprint(sprint.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprint?.id]);

  const changeState = (state: SprintState) => {
    if (!sprint || state === 'planned') return;
    setSprintState.mutate(
      { id: sprint.id, state },
      {
        onSuccess: (updated) => {
          setConfirming(null);
          toast.success(
            state === 'completed' ? `${updated.name} completed` : `${updated.name} started`,
          );
        },
        onError: (error) =>
          toast.error(
            state === 'completed' ? 'The sprint could not be completed' : 'The sprint could not be started',
            { description: error instanceof Error ? error.message : undefined },
          ),
      },
    );
  };

  // Same reasoning as the board on Boards: a sprint board is not a paged list,
  // so it loads in one go and grows on request. What it must not do is show a
  // subset silently — the column counts are computed from what was fetched.
  const [pageSize, setPageSize] = useState(SPRINT_PAGE_SIZE);
  const tasksQuery = useTasks({ sprintId: sprint?.id, pageSize });
  const tasks = tasksQuery.data?.items ?? [];
  const total = tasksQuery.data?.total ?? tasks.length;

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success('Task moved', { description: task.key }),
        onError: () => toast.error('Unable to move the task'),
      },
    );
  };

  if (!sprintsQuery.isLoading && sprints.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Delivery"
          title="Agile"
          description="Sprint delivery workspace."
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New sprint
            </Button>
          }
        />
        <Card>
          <EmptyState
            icon={Timer}
            title="No sprints yet"
            description="Create the first sprint to plan work against it, then start it from here."
            action={{ label: 'New sprint', onClick: () => setCreateOpen(true) }}
          />
        </Card>
        <SprintDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(created) => selectSprint(created.id)}
        />
      </div>
    );
  }

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
            <Select value={sprint.id} onValueChange={selectSprint}>
              <SelectTrigger className="w-56" aria-label="Choose a sprint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['active', 'planned', 'completed'] as SprintState[]).map((state) => {
                  const group = sprints.filter((item) => item.state === state);
                  if (group.length === 0) return null;
                  return (
                    <SelectGroup key={state}>
                      <SelectLabel>{SPRINT_STATE_META[state].label}</SelectLabel>
                      {group.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>

            <Button variant="secondary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New sprint
            </Button>

            {sprint.state === 'planned' ? (
              <Button onClick={() => setConfirming('active')}>
                <CirclePlay className="h-4 w-4" />
                Start sprint
              </Button>
            ) : sprint.state === 'active' ? (
              <Button onClick={() => setConfirming('completed')}>
                <CheckCircle2 className="h-4 w-4" />
                Complete sprint
              </Button>
            ) : null}
          </>
        }
      />

      <SprintDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => selectSprint(created.id)}
      />

      <ConfirmDialog
        open={confirming === 'active'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Start ${sprint.name}?`}
        description="The sprint becomes the active one from today. Work already committed to it stays committed."
        confirmLabel="Start sprint"
        pending={setSprintState.isPending}
        onConfirm={() => changeState('active')}
      />
      <ConfirmDialog
        open={confirming === 'completed'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Complete ${sprint.name}?`}
        description={
          remaining > 0
            ? `${formatNumber(remaining)} ${pluralize(remaining, 'point')} of committed work ${remaining === 1 ? 'is' : 'are'} not done. The sprint closes anyway; move unfinished work to the next sprint from the board.`
            : 'Everything committed is done. The sprint closes and moves to history.'
        }
        confirmLabel="Complete sprint"
        pending={setSprintState.isPending}
        onConfirm={() => changeState('completed')}
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
          <p className="mt-1 text-xs leading-relaxed text-foreground">
            {sprint.goal || (
              <span className="text-muted-foreground">No sprint goal has been set.</span>
            )}
          </p>
        </div>
        <div className="hidden w-40 shrink-0 space-y-1.5 sm:block">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs text-muted-foreground">Progress</span>
            <span className="font-mono text-xs font-semibold tabular-nums">
              {formatPercent(progress)}
            </span>
          </div>
          <ProgressBar value={progress} label={`${sprint.name} progress`} />
          <p className="text-2xs text-muted-foreground">
            {daysLeft >= 0
              ? `${formatNumber(daysLeft)} ${pluralize(daysLeft, 'day')} remaining`
              : 'Sprint window closed'}
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
          support={`${formatPercent(progress)} of commitment`}
          icon={CheckCircle2}
          tone="success"
        />
        <MetricCard
          label="Remaining"
          value={remaining}
          suffix="pts"
          support={
            daysLeft >= 0
              ? `${formatNumber(daysLeft)} ${pluralize(daysLeft, 'day')} left`
              : 'Past the end date'
          }
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

        <QueryBoundary
          isLoading={trendsQuery.isLoading}
          isError={trendsQuery.isError}
          error={trendsQuery.error}
          onRetry={() => trendsQuery.refetch()}
          errorTitle="Unable to load velocity"
          skeleton={<ChartCardSkeleton height={260} />}
        >
          <ChartCard title="Velocity" description="Story points delivered per sprint" height={260}>
            <VelocityChart data={velocity} />
          </ChartCard>
        </QueryBoundary>
      </div>

      {/* Sprint board */}
      <section className="space-y-3">
        <SectionHeader
          title="Sprint board"
          description={`Work committed to ${sprint.name} across every project`}
        />

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

            {/* Renders only when the board is showing a subset. A sprint rarely
                holds more than this, so the normal case is silence. */}
            <TruncationNotice
              shown={tasks.length}
              total={total}
              itemLabel="task"
              affected="The column counts"
              step={SPRINT_PAGE_SIZE}
              loading={tasksQuery.isFetching}
              onLoadMore={() => setPageSize((size) => size + SPRINT_PAGE_SIZE)}
            />
          </div>
        </QueryBoundary>
      </section>

      {/* Sprint work as a paged list, for scanning and for keyboard users the
          board cannot serve. */}
      {tasks.length > 0 ? (
        <SprintWorkList tasks={tasks} users={users} resetKey={sprint.id} />
      ) : null}
    </div>
  );
}
