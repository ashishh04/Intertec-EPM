import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Ellipsis, Eye, Pencil, Send, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState } from '@/components/common/ErrorState';
import { EmptyState } from '@/components/common/EmptyState';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { PriorityBadge, StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
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
import { useAddComment, useTask, useTaskComments, useUpdateTask } from '@/hooks/useTasks';
import { useProject } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { useSprints } from '@/hooks/useSprints';
import {
  ALL_TASK_PRIORITIES,
  TASK_PRIORITY_META,
} from '@/lib/domain';
import { formatDateTime, formatHours, formatLongDate, formatRelative } from '@/lib/utils';
import type { TaskPriority } from '@/types';
import { useStatuses } from '@/hooks/useCatalog';
import { invalidationGroups } from '@/lib/queryKeys';
import { workPackageService } from '@/services';
import { TaskAttachments } from '@/components/tasks/TaskAttachments';
import { TaskRelations } from '@/components/tasks/TaskRelations';
import { TaskWatchers } from '@/components/tasks/TaskWatchers';
import { useAuth } from '@/providers/AuthProvider';

/** Work-package detail. Content on the left, the full metadata panel on the right. */
export default function TaskDetailPage() {
  const { taskId } = useParams();
  const { data: task, isLoading, isError, refetch } = useTask(taskId);
  const { data: project } = useProject(task?.projectId);
  const commentsQuery = useTaskComments(taskId);
  // A long-running work package accumulates discussion; show the latest page first.
  const commentPage = usePagination(commentsQuery.data ?? [], { pageSize: 10, resetKey: taskId });
  const activityQuery = useActivity({ projectId: task?.projectId, limit: 12 });
  const { data: userList } = useUsers();
  const users = useUserMap();
  const sprintsQuery = useSprints();
  const updateTask = useUpdateTask();
  const addComment = useAddComment();
  // Declared with the other hooks: the guards below return early, and a hook
  // after them runs on some renders and not others.
  const { canInProject } = useAuth();
  const statuses = useStatuses();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');

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

  const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;
  const author = users.get(task.authorId);
  const sprint = sprintsQuery.data?.find((item) => item.id === task.sprintId);

  const patch = (values: Parameters<typeof updateTask.mutate>[0]) =>
    updateTask.mutate(values, {
      onSuccess: () => toast.success('Task updated'),
      onError: () => toast.error('Unable to save changes'),
    });

  const submitComment = (event: React.FormEvent) => {
    event.preventDefault();
    const body = comment.trim();
    if (!body) return;

    addComment.mutate(
      { taskId: task.id, body },
      {
        onSuccess: () => {
          setComment('');
          toast.success('Comment added');
        },
        onError: () => toast.error('Unable to post the comment'),
      },
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
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
        }
        title={task.subject}
        meta={
          <>
            <StatusBadge status={task.statusCategory} label={task.status.name} />
            <TypeBadge type={task.type} />
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                toast('Inline editing is not implemented yet', {
                  description: 'Use the properties panel to change status, priority or assignee.',
                })
              }
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  <UserPlus className="h-3.5 w-3.5" />
                  Assign
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {(userList ?? []).map((user) => (
                  <DropdownMenuItem
                    key={user.id}
                    onSelect={() => patch({ id: task.id, assigneeId: user.id })}
                  >
                    {user.name}
                  </DropdownMenuItem>
                ))}
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

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Main */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                {task.description ?? 'No description provided.'}
              </p>

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
                      {commentsQuery.data?.length ?? 0}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="activity" variant="underline">
                    Activity
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="comments" className="p-4">
                <QueryBoundary
                  isLoading={commentsQuery.isLoading}
                  isError={commentsQuery.isError}
                  onRetry={() => commentsQuery.refetch()}
                  errorTitle="Unable to load comments"
                  skeleton={<ActivityTimelineSkeleton rows={3} />}
                  isEmpty={(commentsQuery.data?.length ?? 0) === 0}
                  empty={
                    <EmptyState
                      size="inline"
                      title="No comments yet"
                      description="Start the discussion for this work package."
                    />
                  }
                >
                  <ul className="space-y-4">
                    {commentPage.items.map((entry) => {
                      const commentAuthor = users.get(entry.authorId);
                      return (
                        <li key={entry.id} className="flex gap-3">
                          <UserAvatar user={commentAuthor} size="default" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs font-medium">
                                {commentAuthor?.name ?? 'A teammate'}
                              </span>
                              <time className="text-2xs text-muted-foreground">
                                {formatRelative(entry.createdAt)}
                              </time>
                            </div>
                            <p className="mt-1 rounded-lg bg-muted/70 px-3 py-2 text-xs leading-relaxed text-foreground">
                              {entry.body}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <Pagination
                    page={commentPage.page}
                    pageSize={commentPage.pageSize}
                    total={commentPage.total}
                    onPageChange={commentPage.setPage}
                    itemLabel="comment"
                    variant="compact"
                    className="mt-3 justify-end border-t border-border pt-2"
                  />
                </QueryBoundary>

                <form onSubmit={submitComment} className="mt-4 space-y-2 border-t border-border pt-4">
                  <label htmlFor="task-comment" className="sr-only">
                    Add a comment
                  </label>
                  <Textarea
                    id="task-comment"
                    rows={3}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Add a comment, decision or blocker..."
                  />
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!comment.trim()}
                      loading={addComment.isPending}
                    >
                      <Send className="h-3.5 w-3.5" />
                      Comment
                    </Button>
                  </div>
                </form>
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
                * Offers the instance's real statuses rather than EPM's six
                * categories, and writes the status id upstream. Choosing from
                * categories would have meant picking a representative status on
                * the user's behalf — a page showing "New" that could only be
                * set back to "To Do".
                */}
              <Select
                value={task.status.id}
                onValueChange={(statusId) => {
                  workPackageService
                    .update(task.id, { _links: { status: { href: `/api/v3/statuses/${statusId}` } } })
                    .then(async () => {
                      toast.success('Task updated');
                      for (const key of invalidationGroups.taskWrite) {
                        await queryClient.invalidateQueries({ queryKey: key });
                      }
                    })
                    .catch((error: unknown) =>
                      toast.error('Unable to save changes', {
                        description: error instanceof Error ? error.message : undefined,
                      }),
                    );
                }}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Task status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(statuses.data ?? []).map((status) => (
                    <SelectItem key={status.id} value={status.id}>
                      {status.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="epm-eyebrow">Priority</p>
              <Select
                value={task.priority}
                onValueChange={(value) => patch({ id: task.id, priority: value as TaskPriority })}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Task priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_TASK_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {TASK_PRIORITY_META[priority].label}
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
                <TypeBadge type={task.type} />
              </PropertyRow>

              <PropertyRow label="Priority">
                <PriorityBadge priority={task.priority} />
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
                <span className="font-mono text-2xs">{formatHours(task.spentHours)}</span>
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
