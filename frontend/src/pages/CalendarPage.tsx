import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useCalendarEvents } from '@/hooks/useDashboard';
import { useUI } from '@/providers/UIProvider';
import { cn, toISODateOnly } from '@/lib/utils';
import type { CalendarEvent, CalendarEventKind } from '@/types';

type ViewMode = 'month' | 'week' | 'day';

const KIND_STYLE: Record<CalendarEventKind, string> = {
  task: 'bg-primary-soft text-primary-dark border-primary/25 dark:text-primary',
  milestone: 'bg-warning-soft text-warning border-warning/25',
  sprint: 'bg-accent-soft text-accent border-accent/25',
  meeting: 'bg-highlight-soft text-highlight border-highlight/25',
};

const KIND_LABEL: Record<CalendarEventKind, string> = {
  task: 'Task deadline',
  milestone: 'Milestone',
  sprint: 'Sprint boundary',
  meeting: 'Meeting',
};

/** Deadlines, milestones, sprint boundaries and meetings on one calendar. */
export default function CalendarPage() {
  const { openTaskDrawer } = useUI();
  const [view, setView] = useState<ViewMode>('month');
  const [anchor, setAnchor] = useState(() => new Date());

  const range = useMemo(() => {
    if (view === 'day') return { start: startOfDay(anchor), end: startOfDay(anchor) };
    if (view === 'week') {
      return {
        start: startOfWeek(anchor, { weekStartsOn: 1 }),
        end: endOfWeek(anchor, { weekStartsOn: 1 }),
      };
    }
    return {
      start: startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }),
      end: endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }),
    };
  }, [anchor, view]);

  const eventsQuery = useCalendarEvents({
    from: toISODateOnly(range.start),
    to: toISODateOnly(range.end),
  });

  const days = useMemo(() => eachDayOfInterval(range), [range]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of eventsQuery.data ?? []) {
      const key = toISODateOnly(parseISO(event.date));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    return map;
  }, [eventsQuery.data]);

  const shift = (direction: -1 | 1) => {
    if (view === 'month') setAnchor((current) => (direction === 1 ? addMonths(current, 1) : subMonths(current, 1)));
    else if (view === 'week') setAnchor((current) => addDays(current, direction * 7));
    else setAnchor((current) => addDays(current, direction));
  };

  const title =
    view === 'day'
      ? format(anchor, 'EEEE, d MMMM yyyy')
      : view === 'week'
        ? `${format(range.start, 'd MMM')} — ${format(range.end, 'd MMM yyyy')}`
        : format(anchor, 'MMMM yyyy');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calendar"
        description="Deadlines, milestones and delivery ceremonies across your projects."
        actions={
          <Button onClick={() => openTaskDrawer()}>
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="icon-sm" onClick={() => shift(-1)} aria-label="Previous period">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button variant="secondary" size="icon-sm" onClick={() => shift(1)} aria-label="Next period">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>

        <Tabs
          value={view}
          onValueChange={(value) => setView(value as ViewMode)}
          className="ml-auto"
        >
          <TabsList aria-label="Calendar view">
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="day">Day</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
        {(Object.keys(KIND_LABEL) as CalendarEventKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-sm border', KIND_STYLE[kind])} aria-hidden />
            {KIND_LABEL[kind]}
          </span>
        ))}
      </div>

      <QueryBoundary
        isLoading={eventsQuery.isLoading}
        isError={eventsQuery.isError}
        error={eventsQuery.error}
        onRetry={() => eventsQuery.refetch()}
        errorTitle="Unable to load the calendar"
        skeleton={<Skeleton className="h-[32rem] w-full rounded-xl" />}
      >
        {view === 'day' ? (
          <DayView date={anchor} events={eventsByDay.get(toISODateOnly(anchor)) ?? []} />
        ) : (
          <Card className="overflow-hidden">
            <div className="grid grid-cols-7 border-b border-border bg-surface-sunken/60">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
                <div
                  key={label}
                  className="px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>

            <div className={cn('grid grid-cols-7', view === 'week' && 'min-h-[24rem]')}>
              {days.map((day) => {
                const key = toISODateOnly(day);
                const dayEvents = eventsByDay.get(key) ?? [];
                const outside = view === 'month' && !isSameMonth(day, anchor);

                return (
                  <div
                    key={key}
                    className={cn(
                      'min-h-24 border-b border-r border-border p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0',
                      view === 'week' && 'min-h-[24rem]',
                      outside && 'bg-surface-sunken/40',
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={cn(
                          'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-2xs',
                          isToday(day)
                            ? 'bg-primary font-semibold text-primary-foreground'
                            : outside
                              ? 'text-muted-foreground/50'
                              : 'text-muted-foreground',
                        )}
                      >
                        {format(day, 'd')}
                      </span>
                      {dayEvents.length > 3 ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {dayEvents.length}
                        </span>
                      ) : null}
                    </div>

                    <ul className="space-y-1">
                      {dayEvents.slice(0, view === 'week' ? 12 : 3).map((event) => (
                        <li key={event.id}>
                          <EventChip event={event} />
                        </li>
                      ))}
                      {dayEvents.length > 3 && view === 'month' ? (
                        <li>
                          <button
                            type="button"
                            onClick={() => {
                              setAnchor(day);
                              setView('day');
                            }}
                            className="w-full rounded px-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            +{dayEvents.length - 3} more
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}

function EventChip({ event }: { event: CalendarEvent }) {
  const content = (
    <span
      className={cn(
        'block truncate rounded border px-1.5 py-0.5 text-[10px] leading-tight',
        KIND_STYLE[event.kind],
      )}
      title={event.title}
    >
      {event.title}
    </span>
  );

  return event.taskId ? (
    <Link to={`/tasks/${event.taskId}`} className="block focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {content}
    </Link>
  ) : (
    content
  );
}

function DayView({ date, events }: { date: Date; events: CalendarEvent[] }) {
  const hours = Array.from({ length: 12 }, (_, index) => index + 8); // 08:00 – 19:00

  const timed = events.filter((event) => !event.allDay);
  const allDay = events.filter((event) => event.allDay);

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold tracking-tight">{format(date, 'EEEE d MMMM')}</h3>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {events.length === 0 ? 'Nothing scheduled' : `${events.length} scheduled items`}
        </p>
      </div>

      {allDay.length > 0 ? (
        <div className="space-y-1 border-b border-border bg-surface-sunken/50 p-3">
          <p className="epm-eyebrow mb-1.5">All day</p>
          {allDay.map((event) => (
            <EventChip key={event.id} event={event} />
          ))}
        </div>
      ) : null}

      {events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing scheduled"
          description="Deadlines and ceremonies for this day will appear here."
        />
      ) : (
        <ul className="divide-y divide-border">
          {hours.map((hour) => {
            const slotEvents = timed.filter(
              (event) => parseISO(event.date).getHours() === hour && isSameDay(parseISO(event.date), date),
            );
            return (
              <li key={hour} className="flex gap-3 px-4 py-2">
                <span className="w-12 shrink-0 pt-0.5 font-mono text-2xs text-muted-foreground">
                  {String(hour).padStart(2, '0')}:00
                </span>
                <div className="min-h-5 flex-1 space-y-1">
                  {slotEvents.map((event) => (
                    <EventChip key={event.id} event={event} />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
