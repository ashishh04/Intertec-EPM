import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Timer } from 'lucide-react';
import { SprintSummary, SprintSummaryEmpty, SprintSummarySkeleton } from '@/components/dashboard/SprintSummary';
import { KanbanBoard, KanbanBoardSkeleton } from '@/components/board/KanbanBoard';
import { SectionHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { ImpedimentsPanel } from '@/components/sprints/ImpedimentsPanel';
import { SprintDialog } from '@/components/sprints/SprintDialog';
import { SprintWorkList } from '@/components/sprints/SprintWorkList';
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
import { useProject } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useTasks, useUpdateTask } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { useUI } from '@/providers/UIProvider';
import { SPRINT_STATE_META } from '@/lib/domain';
import { defaultSprint, orderSprints, sprintsOfProject } from '@/lib/sprint-choice';
import { t } from '@/lib/i18n';
import { cn, formatShortDate } from '@/lib/utils';
import type { EpmSprint, ID, SprintState, TaskStatusCategory } from '@/types';

/**
 * How many of the sprint's work packages load at once. A sprint board needs
 * the whole set to drag between columns, so it loads in one go; a sprint
 * rarely holds more than this, and the notice under the board says if it does.
 */
const SPRINT_PAGE_SIZE = 200;

/**
 * This project's sprints: the one running now, any other from the picker, and
 * the board of this project's work in it.
 *
 * It used to show the instance's first running sprint, whichever project that
 * belonged to — so a project whose own sprint had begun still showed another
 * project's, with "This project has no work in the active sprint" beside it,
 * and a sprint made here never appeared.
 */
export default function ProjectSprintTab() {
  const { projectId } = useParams();
  const { openTaskDrawer } = useUI();
  const sprintsQuery = useSprints();
  const projectQuery = useProject(projectId);
  const users = useUserMap();
  const updateTask = useUpdateTask();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  // Every task here is this project's: its name under each, not "Unknown project".
  const projectMap = useMemo(
    () => (projectQuery.data ? new Map([[projectQuery.data.id, projectQuery.data]]) : undefined),
    [projectQuery.data],
  );

  const sprints = useMemo(
    () => orderSprints(sprintsOfProject(sprintsQuery.data ?? [], projectId)),
    [sprintsQuery.data, projectId],
  );

  // The choice lives in the address, so a sprint picked here, or one just made,
  // stays shown through a refresh and can be linked to.
  const selectedId = searchParams.get('sprint');
  const sprint: EpmSprint | undefined = sprints.find((item) => item.id === selectedId) ?? defaultSprint(sprints);

  const selectSprint = (id: ID, options?: { replace?: boolean }) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('sprint', id);
      return next;
    }, options);
  };

  // Pin the default into the address in place, not as a new history entry,
  // which would trap Back (see AgilePage). Not while the list is still loading:
  // a sprint just made is asked for a moment before the list that has it.
  useEffect(() => {
    if (sprint && sprint.id !== selectedId && !sprintsQuery.isFetching) selectSprint(sprint.id, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprint?.id, sprintsQuery.isFetching]);

  const tasksQuery = useTasks(
    { projectId, sprintId: sprint?.id, pageSize: SPRINT_PAGE_SIZE },
    // With no sprint there is no board, and no reason to read the project's every task.
    { enabled: Boolean(sprint) },
  );

  const tasks = useMemo(() => (sprint ? tasksQuery.data?.items ?? [] : []), [sprint, tasksQuery.data]);
  const total = tasksQuery.data?.total ?? tasks.length;

  const handleStatusChange = (taskId: ID, status: TaskStatusCategory) => {
    updateTask.mutate(
      { id: taskId, status },
      {
        onSuccess: (task) => toast.success(t('Task moved'), { description: task.key }),
        onError: () => toast.error(t('Unable to move the task')),
      },
    );
  };

  const hasWork = Boolean(
    sprint && projectId && ((sprint.workProjectIds ?? []).includes(projectId) || tasks.length > 0),
  );

  return (
    <div className="space-y-5">
      <SprintDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={(created) => selectSprint(created.id)}
      />

      <div className="flex flex-wrap items-center gap-2">
        {sprints.length > 0 && sprint ? (
          <Select value={sprint.id} onValueChange={(id) => selectSprint(id)}>
            <SelectTrigger className="w-72" aria-label={t('Choose a sprint')}>
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
                        <span className="truncate">{item.name}</span>
                        <span className="ms-2 font-mono text-2xs text-muted-foreground">
                          {formatShortDate(item.startDate)} – {formatShortDate(item.endDate)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('New sprint')}
        </Button>
        {sprints.length > 0 ? (
          <span className="text-2xs text-muted-foreground">
            {t('{count, plural, one {# sprint in this project} other {# sprints in this project}}', { count: sprints.length })}
          </span>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-1">
          {/* Loading, a sprint, or none — see DashboardPage. */}
          {sprintsQuery.isPending ? (
            <SprintSummarySkeleton />
          ) : sprint ? (
            <SprintSummary sprint={sprint} />
          ) : (
            <SprintSummaryEmpty />
          )}
          {sprint && hasWork && projectId ? (
            <ImpedimentsPanel sprintId={sprint.id} projectId={projectId} tasks={tasks} />
          ) : null}
        </div>

        <div className="space-y-3 lg:col-span-2">
          <SectionHeader
            title={t('Sprint board')}
            description={
              !sprint
                ? t('No sprint in this project yet')
                : hasWork
                  ? t('Work packages from this project in {name}', { name: sprint.name })
                  : t('Nothing from this project is in {name} yet', { name: sprint.name })
            }
          />

          {!sprintsQuery.isPending && !sprint ? (
            <Card>
              <EmptyState
                icon={Timer}
                title={t('No sprints in this project yet')}
                description={t('Make one to plan this project’s work in sprints, or import a plan that names its sprints.')}
                action={{ label: t('New sprint'), onClick: () => setCreateOpen(true) }}
              />
            </Card>
          ) : (
            <QueryBoundary
              isLoading={sprintsQuery.isPending || (Boolean(sprint) && tasksQuery.isLoading)}
              isError={tasksQuery.isError}
              error={tasksQuery.error}
              onRetry={() => tasksQuery.refetch()}
              errorTitle={t('Unable to load sprint work')}
              skeleton={<KanbanBoardSkeleton columns={3} />}
              isEmpty={tasks.length === 0}
              empty={
                <Card>
                  <EmptyState
                    icon={Timer}
                    title={t('Nothing committed to this sprint')}
                    description={t('Add work packages to the sprint from the project backlog.')}
                    action={{
                      label: t('Create task'),
                      onClick: () => openTaskDrawer({ projectId, sprintId: sprint?.id }),
                    }}
                  />
                </Card>
              }
            >
              {/* Dimmed while another sprint's work is still shown in its place. */}
              <div className={cn('space-y-3 transition-opacity', tasksQuery.isPlaceholderData && 'opacity-60')}>
                <KanbanBoard
                  tasks={tasks}
                  users={users}
                  onStatusChange={handleStatusChange}
                  onCreate={(status) => openTaskDrawer({ projectId, status, sprintId: sprint?.id })}
                  columns={['todo', 'in_progress', 'review', 'done']}
                />
                <TruncationNotice shown={tasks.length} total={total} affected={t('The column counts')} />
              </div>
            </QueryBoundary>
          )}
        </div>
      </div>

      {tasks.length > 0 && sprint ? (
        <SprintWorkList tasks={tasks} users={users} projects={projectMap} resetKey={`${projectId}|${sprint.id}`} />
      ) : null}
    </div>
  );
}
