import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarClock, Clock, MapPin, Plus, Users } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { MeetingDialog } from '@/components/meetings/MeetingDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDeleteMeeting, useMeetings } from '@/hooks/useCollaborationModules';
import { intlLocale, t } from '@/lib/i18n';
import { cn, formatLongDate, formatTime } from '@/lib/utils';
import type { EpmMeeting, ID, MeetingFilters, MeetingState } from '@/types';

/**
 * A list of meetings, with its own window switch and pager.
 *
 * Shared by the Meetings page and a project's Meetings tab, because they are the
 * same list with a different scope — and because the alternative was two lists
 * that drift until one of them forgets to show the cancelled ones.
 */

const WINDOWS: { value: NonNullable<MeetingFilters['window']>; label: string }[] = [
  { value: 'upcoming', get label() { return t('Upcoming'); } },
  { value: 'past', get label() { return t('Past'); } },
  { value: 'all', get label() { return t('All'); } },
];

const STATE_TONE: Record<MeetingState, 'success' | 'neutral' | 'danger'> = {
  planned: 'success',
  held: 'neutral',
  cancelled: 'danger',
};

export function MeetingList({
  projectId,
  /** Hides the project column and pre-selects the project when scheduling. */
  scoped = false,
}: {
  projectId?: ID;
  scoped?: boolean;
}) {
  const [window, setWindow] = useState<NonNullable<MeetingFilters['window']>>('upcoming');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EpmMeeting | null>(null);
  const [deleting, setDeleting] = useState<EpmMeeting | null>(null);

  const query = useMeetings({ projectId, window, page, pageSize });
  const remove = useDeleteMeeting();

  const meetings = query.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={window}
          onValueChange={(value) => {
            setWindow(value as typeof window);
            // A window change is a different list, so the pager goes home rather
            // than stranding the reader on a page that no longer exists.
            setPage(1);
          }}
        >
          <TabsList>
            {WINDOWS.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t('Schedule')}
        </Button>
      </div>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load meetings')}
        skeleton={
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        }
        isEmpty={meetings.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={CalendarClock}
              title={window === 'past' ? t('No past meetings') : t('Nothing scheduled')}
              description={
                window === 'past'
                  ? t('Meetings appear here once their start time has passed.')
                  : t('Schedule one and everybody invited will find it here.')
              }
              action={{ label: t('Schedule a meeting'), onClick: () => setCreating(true) }}
            />
          </Card>
        }
      >
        <ul className="space-y-2">
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <MeetingCard
                meeting={meeting}
                showProject={!scoped}
                onEdit={() => setEditing(meeting)}
                onDelete={() => setDeleting(meeting)}
              />
            </li>
          ))}
        </ul>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={query.data?.total ?? meetings.length}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          itemLabel={t('meeting')}
          itemLabelPlural={t('meetings')}
        />
      </QueryBoundary>

      <MeetingDialog open={creating} onOpenChange={setCreating} projectId={projectId} />

      {editing ? (
        <MeetingDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          meeting={editing}
          projectId={projectId}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete this meeting?')}
        description={
          deleting
            ? t('"{title}" and its agenda, minutes and attendance will be removed. This cannot be undone.', { title: deleting.title })
            : undefined
        }
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success(t('Meeting deleted'));
              setDeleting(null);
            },
            onError: (error) =>
              toast.error(t('That meeting could not be deleted'), {
                description: error instanceof Error ? error.message : undefined,
              }),
          });
        }}
      />
    </div>
  );
}

function MeetingCard({
  meeting,
  showProject,
  onEdit,
  onDelete,
}: {
  meeting: EpmMeeting;
  showProject: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const attended = meeting.participants.filter((participant) => participant.attended).length;

  return (
    <Card
      className={cn(
        'flex flex-wrap items-start gap-4 p-4 transition-colors hover:border-primary/30',
        meeting.state === 'cancelled' && 'opacity-70',
      )}
    >
      {/* The date block, so a column of meetings reads as a calendar. */}
      <div className="w-16 shrink-0 text-center">
        <p className="epm-eyebrow">
          {new Date(meeting.startsAt).toLocaleDateString(intlLocale(), { month: 'short' })}
        </p>
        <p className="font-display text-xl font-bold leading-none tracking-[-0.03em]">
          {new Date(meeting.startsAt).toLocaleDateString(intlLocale(), { day: 'numeric' })}
        </p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {new Date(meeting.startsAt).toLocaleDateString(intlLocale(), { weekday: 'short' })}
        </p>
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/meetings/${meeting.id}`}
            dir="auto"
            className={cn(
              'truncate text-sm font-medium hover:underline',
              meeting.state === 'cancelled' && 'line-through',
            )}
          >
            {meeting.title}
          </Link>
          <Badge tone={STATE_TONE[meeting.state]} size="sm">
            {t('{state, select, planned {planned} held {held} cancelled {cancelled} other {{state}}}', { state: meeting.state })}
          </Badge>
          {showProject ? (
            <Badge tone="neutral" size="sm">
              {meeting.projectName ?? (meeting.projectId ? t('Project') : t('Organisation-wide'))}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden />
            {formatTime(meeting.startsAt)}&ndash;{formatTime(meeting.endsAt)} &middot;{' '}
            {formatLongDate(meeting.startsAt)}
          </span>
          {meeting.location ? (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" aria-hidden />
              {meeting.location}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" aria-hidden />
            {/* Attendance once it exists, the invite count before: "3 of 6 came"
                is the useful figure after a meeting and meaningless before one. */}
            {attended > 0
              ? t('{attended, number} of {total, number} attended', { attended, total: meeting.participants.length })
              : t('{count, plural, one {# person invited} other {# people invited}}', { count: meeting.participants.length })}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/meetings/${meeting.id}`}>{t('Open')}</Link>
        </Button>
        {meeting.can.update ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            {t('Edit')}
          </Button>
        ) : null}
        {meeting.can.delete ? (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            {t('Delete')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
