import { Activity, Calculator, CalendarRange, CircleUser, FolderTree, Gauge, Pin, PinOff, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useProjectJournal } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { AuditEvent, ID } from '@/types';

/**
 * A project's journal: what EPM recorded about it, newest first (BRL-02).
 *
 * Every entry names who made the change — or that EPM did, for a scheduled
 * recalculation — and, where the action needed one, why. Nothing here can be
 * edited or removed, by the API or by the database, so this is evidence
 * rather than a feed.
 */

const ICONS: { prefix: string; icon: LucideIcon }[] = [
  { prefix: 'health.override.cleared', icon: PinOff },
  { prefix: 'health.override', icon: Pin },
  { prefix: 'health.calculated', icon: Calculator },
  { prefix: 'project.plan', icon: CalendarRange },
  { prefix: 'project.owner', icon: CircleUser },
  { prefix: 'project.portfolio', icon: FolderTree },
  { prefix: 'project.deleted', icon: Trash2 },
  { prefix: 'health.', icon: Gauge },
];

function iconFor(action: string): LucideIcon {
  return ICONS.find((entry) => action.startsWith(entry.prefix))?.icon ?? Activity;
}

interface ProjectJournalProps {
  projectId: ID;
  /** Only actions starting with this, e.g. `health.`. */
  action?: string;
  limit?: number;
  className?: string;
}

export function ProjectJournal({ projectId, action, limit = 50, className }: ProjectJournalProps) {
  const query = useProjectJournal(projectId, { action, limit });
  const users = useUserMap();

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => query.refetch()}
      errorTitle="Unable to load the journal"
      skeleton={
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      }
      isEmpty={(query.data ?? []).length === 0}
      empty={
        <EmptyState
          size="inline"
          icon={Activity}
          title="Nothing recorded yet"
          description="Health calculations, overrides and plan changes are recorded here as they happen."
        />
      }
    >
      <ol className={cn('space-y-3', className)}>
        {(query.data ?? []).map((entry) => (
          <JournalEntry key={entry.id} entry={entry} actor={entry.actorId ? users.get(entry.actorId) : undefined} />
        ))}
      </ol>
    </QueryBoundary>
  );
}

function JournalEntry({
  entry,
  actor,
}: {
  entry: AuditEvent;
  actor?: ReturnType<ReturnType<typeof useUserMap>['get']>;
}) {
  const Icon = iconFor(entry.action);
  // The automation account is not a person in the directory; it is named for what it is.
  const who =
    entry.actorKind === 'system'
      ? 'EPM'
      : entry.actorKind === 'service'
        ? 'EPM Automation'
        : actor?.name ?? 'Someone no longer listed';

  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed">{entry.summary}</p>
        {entry.reason ? (
          <p className="mt-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
            {entry.reason}
          </p>
        ) : null}
        <p className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
          {entry.actorKind === 'user' ? <UserAvatar user={actor} size="xs" /> : null}
          <span>{who}</span>
          <span aria-hidden>·</span>
          <InfoTooltip label={formatDateTime(entry.occurredAt)}>
            <time dateTime={entry.occurredAt} tabIndex={0}>
              {formatRelative(entry.occurredAt)}
            </time>
          </InfoTooltip>
        </p>
      </div>
    </li>
  );
}
