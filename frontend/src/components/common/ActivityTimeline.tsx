import { Link } from 'react-router-dom';
import { cn, formatRelative } from '@/lib/utils';
import { ACTIVITY_ACTION_LABEL, ACTIVITY_ACTION_TONE, TONE_FILL } from '@/lib/domain';
import { UserAvatar } from './UserAvatar';
import { EmptyState } from './EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import type { ActivityEntry, ID, NexusUser } from '@/types';

interface ActivityTimelineProps {
  entries: ActivityEntry[];
  users: Map<ID, NexusUser>;
  /** Caps the rendered list without changing the query. */
  limit?: number;
  className?: string;
}

function linkFor(entry: ActivityEntry): string | null {
  if (entry.objectType === 'task' && entry.objectId) return `/tasks/${entry.objectId}`;
  if (entry.objectType === 'project' && entry.objectId) return `/projects/${entry.objectId}`;
  if (entry.projectId) return `/projects/${entry.projectId}/activity`;
  return null;
}

/** Reusable actor / action / object / timestamp feed. */
function ActivityTimeline({ entries, users, limit, className }: ActivityTimelineProps) {
  const visible = limit ? entries.slice(0, limit) : entries;

  if (visible.length === 0) {
    return <EmptyState size="inline" title="No recent activity" description="Updates will appear here as work moves." />;
  }

  return (
    <ol className={cn('relative space-y-0.5', className)}>
      {visible.map((entry, index) => {
        const actor = users.get(entry.actorId);
        const href = linkFor(entry);
        const tone = ACTIVITY_ACTION_TONE[entry.action];
        const isLast = index === visible.length - 1;

        return (
          <li key={entry.id} className="relative flex gap-3 pb-3 last:pb-0">
            {!isLast ? (
              <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-border" aria-hidden />
            ) : null}

            <span className="relative mt-0.5 shrink-0">
              <UserAvatar user={actor} size="default" />
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface',
                  TONE_FILL[tone],
                )}
                aria-hidden
              />
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-xs leading-relaxed text-foreground">
                <span className="font-medium">{actor?.name ?? 'A teammate'}</span>{' '}
                <span className="text-muted-foreground">{ACTIVITY_ACTION_LABEL[entry.action]}</span>{' '}
                {href ? (
                  <Link
                    to={href}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {entry.objectLabel}
                  </Link>
                ) : (
                  <span className="font-medium">{entry.objectLabel}</span>
                )}
              </p>
              {entry.detail ? (
                <p className="mt-0.5 truncate text-2xs text-muted-foreground">{entry.detail}</p>
              ) : null}
              <time className="mt-0.5 block font-mono text-2xs text-muted-foreground/80">
                {formatRelative(entry.timestamp)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ActivityTimelineSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3.5">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5 pt-1">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { ActivityTimeline, ActivityTimelineSkeleton };
