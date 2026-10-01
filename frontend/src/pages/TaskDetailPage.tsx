import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Ellipsis, Eye, Pencil, Timer, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState } from '@/components/common/ErrorState';
import { EmptyState } from '@/components/common/EmptyState';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { PriorityBadge, StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useComments } from '@/hooks/useComments';
import { useTask, useUpdateTask } from '@/hooks/useTasks';
import { useProject } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { useSprints } from '@/hooks/useSprints';
import { formatDateTime, formatHours, formatLongDate, formatRelative } from '@/lib/utils';
import {
  usePriorities,
  useProjectAssignees,
  useStatuses,
  useWorkPackageOptions,
} from '@/hooks/useCatalog';
import { TaskAttachments } from '@/components/tasks/TaskAttachments';
import { TaskComments } from '@/components/tasks/TaskComments';
import { TaskRelations } from '@/components/tasks/TaskRelations';
import { TaskWatchers } from '@/components/tasks/TaskWatchers';
import { HierarchyTrail, TaskSubItems } from '@/components/tasks/TaskHierarchy';
import { WorkPackageDialog } from '@/components/tasks/WorkPackageDialog';
import { LogTimeDialog } from '@/components/tasks/LogTimeDialog';
import { useAuth } from '@/providers/AuthProvider';

/** Work-package detail. Content on the left, the full metadata panel on the right. */
export default function TaskDetailPage() {
  const { taskId } = useParams();
  const { data: task, isLoading, isError, refetch } = useTask(taskId);
  const { data: project } = useProject(task?.projectId);
  // Read here only for the tab's count. TaskComments asks for the same data and
  // React Query serves both from one request.
  const comments = useComments(taskId);
  const activityQuery = useActivity({ projectId: task?.projectId, limit: 12 });
  const users = useUserMap();
  const sprintsQuery = useSprints();
  const updateTask = useUpdateTask();
  // Declared with the other hooks: the guards below return early, and a hook
  // after them runs on some renders and not others.
  const { canInProject } = useAuth();
  const statuses = useStatuses();
  const priorities = usePriorities();
  // What this work package may actually be moved to, as opposed to what the
  // instance defines. See useWorkPackageOptions.
  const { data: allowed } = useWorkPackageOptions(taskId);
  const [editingAllFields, setEditingAllFields] = useState(false);
  const [loggingTime, setLoggingTime] = useState(false);
  // The project's members, not the directory: OpenProject refuses an assignee
  // who is not one with "The chosen user is not allowed to be 'Assignee' for
  // this work package".
  const { data: assignees } = useProjectAssignees(task?.projectId);

  if (isError) {
    return (
      <ErrorState
        title="Unable to load task"
        description="Something went wrong while loading this work package."
        onRetry={() => refetch()}
      />
    );
  }

  if (isLoading || !task) {
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  /*
   * The permitted values, with whatever is set now guaranteed to be among them.
   *
   * A select whose value is absent from its options renders blank, which would
   * be a worse fault than the one this list fixes — so the current value is
   * merged in rather than trusted to be there.
   */
  type Option = { id: string; name: string };
  const withCurrent = (
    permitted: readonly Option[] | undefined,
    fallback: readonly Option[] | undefined,
    current: Option,
  ): Option[] => {
    const options = permitted ?? fallback ?? [];
    return options.some((option) => option.id === current.id)
      ? [...options]
      : [current, ...options];
  };

  const statusOptions = withCurrent(allowed?.statuses, statuses.data, task.status);
  const priorityOptions = withCurrent(allowed?.priorities, priorities.data, task.priorityRef);

  const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;
  const author = users.get(task.authorId);
  const sprint = sprintsQuery.data?.find((item) => item.id === task.sprintId);

  const patch = (values: Parameters<typeof updateTask.mutate>[0]) =>
    updateTask.mutate(values, {
      onSuccess: () => toast.success('Task updated'),
      // OpenProject refuses a change for reasons only it knows — a workflow
      // that does not allow the transition, a required field the new status
      // brings with it. Its sentence is the useful one; a flat "Unable to save
      // changes" was indistinguishable from the control doing nothing at all.
      onError: (error) =>
        toast.error('Unable to save changes', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <span className="flex flex-col gap-1">
            {/* What this work is part of, read before the work itself. */}
            <HierarchyTrail taskId={task.id} />
            <span className="flex items-center gap-2">
              <span className="font-mono">{task.key}</span>
              {project ? (
                <>
                  <span aria-hidden>·</span>
                  <Link to={`/projects/${project.id}`} className="hover:text-foreground">
                    {project.name}
                  </Link>
                </>
              ) : null}
            </span>
          </span>
        }
        title={task.subject}
        meta={
          <>
            <StatusBadge status={task.statusCategory} label={task.status.name} />
            <TypeBadge type={task.type} label={task.typeRef.name} />
          </>
        }
        actions={
          <>
            {/*
              * Every field the instance defines, not a curated subset.
              *
              * The panel on the right covers what is changed most often. This
              * is the whole record — the attribute groups OpenProject itself
              * shows, custom fields included, with their own allowed values and
              * validation. Nothing about which fields exist is decided here.
              */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditingAllFields(true)}
              disabled={!canInProject(task.projectId, 'task:edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit all fields
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  <UserPlus className="h-3.5 w-3.5" />
                  Assign
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {(assignees ?? []).map((person) => (
                  <DropdownMenuItem
                    key={person.id}
                    onSelect={() => patch({ id: task.id, assigneeId: person.id })}
                  >
                    {person.name}
                  </DropdownMenuItem>
                ))}

                {/*
                  Nobody assignable is a real answer, not a loading state.

                  OpenProject will only accept an assignee who is a member of the
                  project — an administrator who is not a member is refused just
                  like anybody else, with "The chosen user is not allowed to be
                  'Assignee' for this work package". So an empty list here is
                  correct, and the menu has to say why: it previously showed a
                  heading over nothing, which reads as the feature being broken.
                */}
                {(assignees ?? []).length === 0 ? (
                  <div className="px-2 py-1.5">
                    <p className="text-2xs text-muted-foreground">
                      Nobody can be assigned yet — this project has no members. Add people on the
                      project&rsquo;s Team tab first.
                    </p>
                    <Button asChild variant="ghost" size="sm" className="mt-1.5 w-full text-2xs">
                      <Link to={`/projects/${task.projectId}/team`}>Open the Team tab</Link>
                    </Button>
                  </div>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                toast.success(
                  task.watcherIds.length > 0 ? 'You are watching this task' : 'Watching this task',
                )
              }
            >
              <Eye className="h-3.5 w-3.5" />
              Watch
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More task actions">
                  <Ellipsis className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    navigator.clipboard?.writeText(window.location.href);
                    toast.success('Link copied');
                  }}
                >
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => patch({ id: task.id, status: 'done' })}>
                  Mark as done
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={() =>
                    toast('Deleting is not enabled from this view', {
                      description: 'Use bulk actions in the task list to remove work packages.',
                    })
                  }
                >
                  Delete task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <WorkPackageDialog
        open={editingAllFields}
        onOpenChange={setEditingAllFields}
        workPackageId={task.id}
      />

      <LogTimeDialog
        open={loggingTime}
        onOpenChange={setLoggingTime}
        workPackageId={task.id}
        projectId={task.projectId}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Main */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {task.description ? (
                <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {task.description}
                </p>
              ) : (
                <EmptyState
                  size="inline"
                  title="No description yet"
                  description="Add one in the delivery system and it will appear here."
                />
              )}

              {task.labels.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-4">
                  {task.labels.map((label) => (
                    <Badge key={label} size="sm" tone="neutral">
                      {label}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <TaskAttachments
            workPackageId={task.id}
            // Attaching is an edit of the work package, so it follows the same
            // permission; the backend checks it again regardless.
            canUpload={canInProject(task.projectId, 'task:edit')}
          />

          {/* What is broken out under this work package. Above relations
              deliberately: a parent-child breakdown is read far more often
              than a cross-cutting relation. */}
          <TaskSubItems taskId={task.id} />

          {/* Both are affordance-gated inside: what a user may do is decided by
              what OpenProject offered on this record, not by a role check. */}
          <TaskRelations workPackageId={task.id} />

          <TaskWatchers workPackageId={task.id} />

          <Card>
            <Tabs defaultValue="comments">
              <div className="border-b border-border px-4 pt-3">
                <TabsList variant="underline">
                  <TabsTrigger value="comments" variant="underline">
                    Comments{' '}
                    <span className="font-mono text-2xs text-muted-foreground">
                      {comments.data?.length ?? 0}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="activity" variant="underline">
                    Activity
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="comments" className="p-4">
                <TaskComments
                  workPackageId={task.id}
                  // Commenting is affordance-gated in the backend; this only
                  // decides whether the box is worth showing.
                  canComment={canInProject(task.projectId, 'task:edit')}
                />
              </TabsContent>

              <TabsContent value="activity" className="p-4">
                <QueryBoundary
                  isLoading={activityQuery.isLoading}
                  isError={activityQuery.isError}
                  onRetry={() => activityQuery.refetch()}
                  errorTitle="Unable to load activity"
                  skeleton={<ActivityTimelineSkeleton rows={5} />}
                >
                  <ActivityTimeline entries={activityQuery.data ?? []} users={users} limit={10} />
                </QueryBoundary>
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        {/* Properties panel */}
        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader className="border-b border-border">
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-1.5">
              <p className="epm-eyebrow">Status</p>
              {/*
                * Offers the transitions this work package actually permits.
                *
                * Two narrowings, and both matter. EPM's six categories are not
                * the list: choosing from them would pick a representative
                * status on the user's behalf — a page showing "New" that could
                * only be set back to "To Do". Nor is the instance's full list:
                * OpenProject gates a status change on the workflow for this
                * type, role and current status, so most of those fourteen were
                * refused on click and the control looked inert. The work
                * package's own form is the only thing that knows which apply.
                */}
              <Select
                value={task.status.id}
                // The id, not a URL. The backend turns it into an upstream
                // link — the browser has no business knowing that shape.
                onValueChange={(statusId) => patch({ id: task.id, statusId })}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Task status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((status) => (
                    <SelectItem key={status.id} value={status.id}>
                      {status.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="epm-eyebrow">Priority</p>
              {/*
                * The instance's real priorities, for the same reason as status
                * above. EPM's four categories are a grouping, not the list: an
                * instance configured with Low/Normal/High/Immediate was being
                * shown Low/Medium/High/Critical, which renames two of them and
                * hides any fifth the administrator adds.
                */}
              <Select
                value={task.priorityRef.id}
                onValueChange={(priorityId) => patch({ id: task.id, priorityId })}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Task priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorityOptions.map((priority) => (
                    <SelectItem key={priority.id} value={priority.id}>
                      {priority.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <p className="epm-eyebrow">Progress</p>
              <div className="flex items-center gap-2">
                <ProgressBar value={task.progress} size="sm" label="Task progress" className="flex-1" />
                <span className="font-mono text-2xs tabular-nums">{task.progress}%</span>
              </div>
            </div>

            <Separator />

            <dl className="space-y-3">
              <PropertyRow label="Assignee">
                <span className="flex items-center gap-2">
                  <UserAvatar user={assignee} size="xs" />
                  <span className="truncate text-xs">{assignee?.name ?? 'Unassigned'}</span>
                </span>
              </PropertyRow>

              <PropertyRow label="Author">
                <span className="flex items-center gap-2">
                  <UserAvatar user={author} size="xs" />
                  <span className="truncate text-xs">{author?.name ?? 'Unknown'}</span>
                </span>
              </PropertyRow>

              <PropertyRow label="Project">
                {project ? (
                  <Link to={`/projects/${project.id}`} className="text-xs text-primary hover:underline">
                    {project.name}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </PropertyRow>

              <PropertyRow label="Type">
                <TypeBadge type={task.type} label={task.typeRef.name} />
              </PropertyRow>

              <PropertyRow label="Priority">
                {/* The instance's name, coloured by EPM's grouping of it. */}
                <PriorityBadge priority={task.priority} label={task.priorityRef.name} />
              </PropertyRow>

              <PropertyRow label="Start date">
                <span className="font-mono text-2xs">{formatLongDate(task.startDate)}</span>
              </PropertyRow>

              <PropertyRow label="Due date">
                <span className="font-mono text-2xs">{formatLongDate(task.dueDate)}</span>
              </PropertyRow>

              <PropertyRow label="Estimated">
                <span className="font-mono text-2xs">{formatHours(task.estimatedHours)}</span>
              </PropertyRow>

              <PropertyRow label="Spent">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-2xs">{formatHours(task.spentHours)}</span>
                  {/* Whether this person may log time is OpenProject's answer,
                      not EPM's — there is no capability to check — so the
                      action is always offered and the refusal, if any, comes
                      back from the form with its reason. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-2xs"
                    onClick={() => setLoggingTime(true)}
                  >
                    <Timer className="h-3 w-3" />
                    Log
                  </Button>
                </span>
              </PropertyRow>

              <PropertyRow label="Story points">
                <span className="font-mono text-2xs">{task.storyPoints ?? '—'}</span>
              </PropertyRow>

              <PropertyRow label="Sprint">
                <span className="text-xs">{sprint?.name ?? 'Backlog'}</span>
              </PropertyRow>

              <PropertyRow label="Version">
                <span className="font-mono text-2xs">{task.version ?? '—'}</span>
              </PropertyRow>
            </dl>

            <Separator />

            <p className="text-2xs text-muted-foreground">
              Created {formatDateTime(task.createdAt)}
              <br />
              Updated {formatRelative(task.updatedAt)}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-2xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
