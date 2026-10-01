import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { addDays, startOfWeek } from 'date-fns';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TimeEntryDialog } from '@/components/time/TimeEntryDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeleteTimeEntry, useTimeEntries } from '@/hooks/useTimeEntries';
import { useEmployee } from '@/hooks/useEmployees';
import { usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { cn, formatHours, formatWeekdayDate, toISODateOnly } from '@/lib/utils';
import type { EpmTimeEntry, Weekday } from '@/types';

/** `Date.getDay()` order, so a day object maps straight to a weekday key. */
const WEEKDAY_BY_INDEX: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * My time tracking.
 *
 * A week at a time, because that is the unit time is reported in: a timesheet
 * is submitted weekly, capacity is contracted weekly, and "did I account for
 * Tuesday" is the question this page exists to answer. All seven day columns
 * are always drawn, including the empty ones — a missing day is the finding,
 * and a list that simply omits it hides that.
 *
 * Everything here is the signed-in person's own time. Reading anybody else's is
 * the Time & Costs report, which is grouped and filtered rather than editable.
 */
export default function MyTimePage() {
  const { user } = useAuth();
  const { preferences } = usePreferences();

  // Monday or Sunday, from the person's own preference — the same setting the
  // rest of the product honours, so their week does not start on two days.
  const weekStartsOn = preferences.workweek.startOfWeek === 'sunday' ? 0 : 1;
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date(), { weekStartsOn }));

  const weekStart = useMemo(() => startOfWeek(anchor, { weekStartsOn }), [anchor, weekStartsOn]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart],
  );
  const from = toISODateOnly(weekStart);
  const to = toISODateOnly(days[6]!);

  const entriesQuery = useTimeEntries(
    // 200 is the upstream page ceiling and far above a plausible week: 200
    // entries in seven days is 28 a day. One page is the whole week.
    //
    // `me` rather than this person's id: OpenProject validates a numeric id in
    // this filter against the principals the caller can see, and somebody who
    // belongs to no project is not in their own visible set — so their own
    // timesheet came back "Filters User filter has invalid values" instead of an
    // empty week. `me` is resolved from the token and is always valid.
    { userId: 'me', from, to, pageSize: 200 },
  );
  // Capacity is EPM's own field and the only thing that makes the week's total
  // mean anything. Absent for anyone unmapped, in which case no bar is drawn.
  const profile = useEmployee(user?.id);

  const remove = useDeleteTimeEntry();
  const [editing, setEditing] = useState<EpmTimeEntry | null>(null);
  const [creatingOn, setCreatingOn] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EpmTimeEntry | null>(null);

  const entries = entriesQuery.data?.items ?? [];

  const byDay = useMemo(() => {
    const map = new Map<string, EpmTimeEntry[]>();
    for (const day of days) map.set(toISODateOnly(day), []);
    for (const entry of entries) map.get(entry.spentOn)?.push(entry);
    return map;
  }, [days, entries]);

  const total = entries.reduce((sum, entry) => sum + entry.hours, 0);
  const capacity = profile.data?.hoursCapacity ?? 0;
  // Their declared working week, so a Saturday reads as a Saturday rather than
  // as a day they forgot to fill in.
  const workingDays = new Set(preferences.availability.workingDays);
  const today = toISODateOnly(new Date());
  const thisWeek = from === toISODateOnly(startOfWeek(new Date(), { weekStartsOn }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="My time tracking"
        description="Everything you have logged, a week at a time."
        actions={
          <>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous week"
                onClick={() => setAnchor(addDays(weekStart, -7))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-w-24 text-2xs"
                disabled={thisWeek}
                onClick={() => setAnchor(startOfWeek(new Date(), { weekStartsOn }))}
              >
                This week
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next week"
                onClick={() => setAnchor(addDays(weekStart, 7))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button onClick={() => setCreatingOn(thisWeek ? today : from)}>
              <Plus className="h-4 w-4" />
              Log time
            </Button>
          </>
        }
      />

      {/* The week in one line: what was logged, against what was contracted. */}
      <Card>
        <CardHeader variant="compact">
          <CardTitle>
            {formatWeekdayDate(weekStart)} &ndash; {formatWeekdayDate(days[6])}
          </CardTitle>
          <CardDescription className="text-2xs">
            {capacity > 0
              ? `${formatHours(total)} logged of ${formatHours(capacity)} contracted`
              : `${formatHours(total)} logged`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {capacity > 0 ? (
            <ProgressBar
              value={Math.min(100, Math.round((total / capacity) * 100))}
              // Over capacity is the useful signal, so it is coloured rather
              // than clamped out of sight.
              tone={total > capacity ? 'warning' : total >= capacity ? 'success' : 'primary'}
            />
          ) : (
            <p className="text-2xs text-muted-foreground">
              No weekly capacity is set for you, so there is nothing to measure this against.
            </p>
          )}
        </CardContent>
      </Card>

      <QueryBoundary
        isLoading={entriesQuery.isLoading}
        isError={entriesQuery.isError}
        error={entriesQuery.error}
        onRetry={() => entriesQuery.refetch()}
        errorTitle="Unable to load your time"
        skeleton={
          <div className="grid gap-3 lg:grid-cols-7">
            {days.map((day) => (
              <Skeleton key={day.toISOString()} className="h-40 w-full" />
            ))}
          </div>
        }
      >
        <div className="grid gap-3 lg:grid-cols-7">
          {days.map((day) => {
            const date = toISODateOnly(day);
            const dayEntries = byDay.get(date) ?? [];
            const dayTotal = dayEntries.reduce((sum, entry) => sum + entry.hours, 0);

            const working = workingDays.has(WEEKDAY_BY_INDEX[day.getDay()]!);

            return (
              <Card
                key={date}
                className={cn(
                  'flex min-h-40 flex-col',
                  date === today && 'ring-1 ring-primary/40',
                  // Dimmed, not hidden: time logged on a non-working day is
                  // real and has to stay visible and editable.
                  !working && 'bg-muted/30',
                )}
              >
                <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="epm-eyebrow">
                      {day.toLocaleDateString('en-US', { weekday: 'short' })}
                      {!working ? (
                        <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground">
                          &middot; off
                        </span>
                      ) : null}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {day.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                  {dayTotal > 0 ? (
                    <Badge tone="highlight" size="sm">
                      {formatHours(dayTotal)}
                    </Badge>
                  ) : null}
                </div>

                <div className="flex-1 divide-y divide-border">
                  {dayEntries.map((entry) => (
                    <DayEntry
                      key={entry.id}
                      entry={entry}
                      onEdit={() => setEditing(entry)}
                      onDelete={() => setDeleting(entry)}
                    />
                  ))}
                  {dayEntries.length === 0 ? (
                    <p className="px-3 py-3 text-2xs text-muted-foreground">Nothing logged</p>
                  ) : null}
                </div>

                <div className="border-t border-border p-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-2xs"
                    onClick={() => setCreatingOn(date)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>

        {entries.length === 0 ? (
          <Card>
            <EmptyState
              icon={CalendarClock}
              title="No time logged this week"
              description="Log against a task from its page, or add an entry here."
              action={{ label: 'Log time', onClick: () => setCreatingOn(thisWeek ? today : from) }}
            />
          </Card>
        ) : null}
      </QueryBoundary>

      {creatingOn ? (
        <TimeEntryDialog
          open
          onOpenChange={(open) => !open && setCreatingOn(null)}
          spentOn={creatingOn}
        />
      ) : null}

      {editing ? (
        <TimeEntryDialog open onOpenChange={(open) => !open && setEditing(null)} entry={editing} />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this entry?"
        description={
          deleting
            ? `${formatHours(deleting.hours)} on ${deleting.spentOn} will be removed from the timesheet.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Entry deleted');
              setDeleting(null);
            },
            onError: (error) =>
              toast.error('That entry could not be deleted', {
                description: error instanceof Error ? error.message : undefined,
              }),
          });
        }}
      />
    </div>
  );
}

/**
 * One entry in a day column.
 *
 * Edit and delete follow the entry's own affordances rather than who is looking
 * at it: OpenProject lets a person log their own time in a project where they
 * may not touch anybody else's, and `can` is its answer per record.
 */
function DayEntry({
  entry,
  onEdit,
  onDelete,
}: {
  entry: EpmTimeEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group space-y-1 px-3 py-2">
      <div className="flex items-start justify-between gap-1.5">
        <span className="font-mono text-xs font-medium">{formatHours(entry.hours)}</span>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {entry.can.update ? (
            <Button variant="ghost" size="icon-sm" aria-label="Edit entry" onClick={onEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
          ) : null}
          {entry.can.delete ? (
            <Button variant="ghost" size="icon-sm" aria-label="Delete entry" onClick={onDelete}>
              <Trash2 className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      </div>

      {entry.workPackageId ? (
        <Link
          to={`/tasks/${entry.workPackageId}`}
          className="block truncate text-2xs text-foreground hover:underline"
          title={entry.workPackageSubject}
        >
          {entry.workPackageSubject ?? `#${entry.workPackageId}`}
        </Link>
      ) : (
        <p className="truncate text-2xs text-muted-foreground" title={entry.projectName}>
          {entry.projectName ?? 'Project'}
        </p>
      )}

      {entry.activityName ? (
        <p className="flex items-center gap-1 truncate text-2xs text-muted-foreground">
          <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden />
          {entry.activityName}
        </p>
      ) : null}

      {entry.comment ? (
        <p className="line-clamp-2 text-2xs text-muted-foreground">{entry.comment}</p>
      ) : null}
    </div>
  );
}
