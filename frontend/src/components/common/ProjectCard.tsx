import { Link } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Users } from 'lucide-react';
import { cn, formatNumber, formatPercent, formatShortDate, isOverdue, pluralize } from '@/lib/utils';
import { PROJECT_STATUS_META } from '@/lib/domain';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectStatusBadge } from './StatusBadge';
import { AvatarGroup } from './UserAvatar';
import type { ID, EpmProject, EpmUser } from '@/types';

interface ProjectHealthCardProps {
  project: EpmProject;
  users: Map<ID, EpmUser>;
  className?: string;
}

/** Project health tile used on the dashboard and the projects grid. */
function ProjectHealthCard({ project, users, className }: ProjectHealthCardProps) {
  const members = project.memberIds.map((id) => users.get(id));
  const tone = PROJECT_STATUS_META[project.status].tone;
  const overdue = isOverdue(project.dueDate) && project.status !== 'completed';

  return (
    // The lift is a CSS transition on the link itself, so the whole tile is
    // one focusable element with no wrapper to animate.
    <Link
      to={`/projects/${project.id}`}
      className={cn(
        'flex h-full flex-col gap-3.5 rounded-lg border border-border bg-surface p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {project.name}
          </h3>
          <p className="mt-0.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            {project.identifier} · {project.portfolio}
          </p>
        </div>
        <ProjectStatusBadge status={project.status} size="sm" />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-2xs text-muted-foreground">Progress</span>
          <span className="font-mono text-xs font-medium tabular-nums text-foreground">
            {formatPercent(project.progress)}
          </span>
        </div>
        <ProgressBar value={project.progress} tone={tone} size="sm" label={`${project.name} progress`} />
      </div>

      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3 text-2xs">
        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Tasks
          </dt>
          <dd className="mt-0.5 truncate font-mono font-medium tabular-nums text-foreground">
            {formatNumber(project.completedTaskCount)}/{formatNumber(project.taskCount)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <CalendarDays className="h-3 w-3" aria-hidden />
            Due
          </dt>
          <dd
            className={cn(
              'mt-0.5 truncate font-mono font-medium text-foreground',
              overdue && 'text-danger',
            )}
          >
            {formatShortDate(project.dueDate)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Users className="h-3 w-3" aria-hidden />
            Team
          </dt>
          <dd className="mt-0.5">
            <AvatarGroup users={members} max={3} size="xs" />
          </dd>
        </div>
      </dl>
    </Link>
  );
}

/** Compact row variant used in dense lists such as the portfolio sidebar. */
function ProjectRow({ project, className }: { project: EpmProject; className?: string }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className={cn(
        'flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-2xs font-semibold text-muted-foreground">
        {project.identifier}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{project.name}</span>
        <span className="block text-2xs text-muted-foreground">
          {formatNumber(project.taskCount)} {pluralize(project.taskCount, 'task')} ·{' '}
          {formatPercent(project.progress)}
        </span>
      </span>
      <ProjectStatusBadge status={project.status} size="sm" />
    </Link>
  );
}

function ProjectCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3.5 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-2.5 w-24" />
        </div>
        <Skeleton className="h-5 w-16 rounded-md" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="space-y-1">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-3 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export { ProjectHealthCard, ProjectRow, ProjectCardSkeleton };
