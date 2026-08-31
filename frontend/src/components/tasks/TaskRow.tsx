import { Link } from 'react-router-dom';
import { cn, describeDueDate } from '@/lib/utils';
import { StatusBadge, PriorityBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Skeleton } from '@/components/ui/skeleton';
import type { NexusProject, NexusTask, NexusUser } from '@/types';

const DUE_TONE = {
  overdue: 'text-danger font-medium',
  today: 'text-warning font-medium',
  soon: 'text-foreground',
  normal: 'text-muted-foreground',
  none: 'text-muted-foreground/70',
} as const;

interface TaskRowProps {
  task: NexusTask;
  project?: NexusProject;
  assignee?: NexusUser;
  className?: string;
}

/**
 * Single work item as it appears in personal queues. The whole row is one link
 * target so it is reachable by keyboard in a single tab stop.
 */
function TaskRow({ task, project, assignee, className }: TaskRowProps) {
  const due = describeDueDate(task.dueDate, task.status === 'done');

  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        'group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    >
      <PriorityBadge priority={task.priority} className="shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
          <span className="truncate text-xs font-medium text-foreground group-hover:text-primary">
            {task.subject}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="truncate">{project?.name ?? 'Unknown project'}</span>
          {task.labels.length > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{task.labels.slice(0, 2).join(', ')}</span>
            </>
          ) : null}
        </div>
      </div>

      <span className={cn('hidden shrink-0 text-2xs sm:block', DUE_TONE[due.tone])}>{due.label}</span>

      <UserAvatarWithTooltip user={assignee} size="sm" className="hidden shrink-0 sm:inline-flex" />

      <StatusBadge status={task.status} size="sm" className="shrink-0" />
    </Link>
  );
}

function TaskRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-3 w-10" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-2.5 w-1/4" />
      </div>
      <Skeleton className="hidden h-2.5 w-16 sm:block" />
      <Skeleton className="hidden h-6 w-6 rounded-full sm:block" />
      <Skeleton className="h-5 w-20 rounded-md" />
    </div>
  );
}

function TaskListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, index) => (
        <TaskRowSkeleton key={index} />
      ))}
    </div>
  );
}

export { TaskRow, TaskRowSkeleton, TaskListSkeleton };
