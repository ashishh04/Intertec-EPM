import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  format,
  isSameDay,
  isWeekend,
  max as maxDate,
  min as minDate,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { Diamond, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { StatusBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { TASK_STATUS_META, TONE_FILL } from '@/lib/domain';
import { cn, formatPercent, formatShortDate } from '@/lib/utils';
import type { ID, Milestone, EpmTask, EpmUser } from '@/types';

type ZoomLevel = 'day' | 'week' | 'month';

const COLUMN_WIDTH: Record<ZoomLevel, number> = { day: 34, week: 14, month: 5 };
const ROW_HEIGHT = 34;
/** Height of the milestone strip that sits above the task bars. */
const MILESTONE_LANE = 22;

interface GanttChartProps {
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  milestones?: Milestone[];
  className?: string;
}

/**
 * Timeline view of scheduled work.
 *
 * The left pane lists the work packages, the right pane draws their bars on a
 * shared date scale with a today marker, weekend shading, milestone diamonds
 * and dependency links between consecutive items in a chain.
 */
export function GanttChart({ tasks, users, milestones = [], className }: GanttChartProps) {
  const [zoom, setZoom] = useState<ZoomLevel>('week');
  const scrollRef = useRef<HTMLDivElement>(null);

  const allScheduled = useMemo(
    () => tasks.filter((task) => task.startDate && task.dueDate),
    [tasks],
  );

  // The date scale spans the whole plan; only the rows page, so scrolling the
  // timeline never means scrolling past dozens of task rows.
  const paged = usePagination(allScheduled, { pageSize: 15, resetKey: zoom });
  const scheduled = paged.items;

  const range = useMemo(() => {
    if (allScheduled.length === 0) {
      const today = new Date();
      return { start: startOfMonth(today), end: endOfMonth(addDays(today, 30)) };
    }
    const starts = allScheduled.map((task) => parseISO(task.startDate!));
    const ends = allScheduled.map((task) => parseISO(task.dueDate!));
    const milestoneDates = milestones.map((milestone) => parseISO(milestone.date));

    return {
      start: startOfWeek(minDate([...starts, ...milestoneDates, new Date()]), { weekStartsOn: 1 }),
      end: addDays(maxDate([...ends, ...milestoneDates, new Date()]), 3),
    };
  }, [allScheduled, milestones]);

  const days = useMemo(
    () => eachDayOfInterval({ start: range.start, end: range.end }),
    [range],
  );

  const columnWidth = COLUMN_WIDTH[zoom];
  const totalWidth = days.length * columnWidth;
  const today = new Date();
  const todayOffset = differenceInCalendarDays(today, range.start) * columnWidth;

  // The plan can start months before today. Open the timeline on the current
  // date so the bars people care about are visible without scrolling.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollLeft = Math.max(0, todayOffset - container.clientWidth / 4);
  }, [todayOffset, zoom]);

  // Month bands drawn above the day scale.
  const monthBands = useMemo(() => {
    const bands: { label: string; width: number; offset: number }[] = [];
    let index = 0;
    while (index < days.length) {
      const monthStart = days[index];
      let span = 0;
      while (index + span < days.length && days[index + span].getMonth() === monthStart.getMonth()) {
        span += 1;
      }
      // The label is chosen by the band's width in pixels, not its day count,
      // so a month that only just enters the range at one edge never spills
      // its name over the next month's. Too narrow for even the short form
      // and it stays unlabelled; the day scale below still dates it.
      const width = span * columnWidth;
      bands.push({
        label: width >= 120 ? format(monthStart, 'MMMM yyyy') : width >= 44 ? format(monthStart, 'MMM') : '',
        width,
        offset: index * columnWidth,
      });
      index += span;
    }
    return bands;
  }, [days, columnWidth]);

  if (allScheduled.length === 0) {
    return (
      <Card className={className}>
        <EmptyState
          title="Nothing scheduled yet"
          description="Work packages need a start and due date before they appear on the timeline."
        />
      </Card>
    );
  }

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-3 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
            Scheduled work
          </span>
          <span className="flex items-center gap-1.5">
            <Diamond className="h-3 w-3 fill-warning text-warning" aria-hidden />
            Milestone
          </span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <span className="h-3 w-px bg-danger" aria-hidden />
            Today
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Tabs value={zoom} onValueChange={(value) => setZoom(value as ZoomLevel)}>
            <TabsList>
              <TabsTrigger value="day">Day</TabsTrigger>
              <TabsTrigger value="week">Week</TabsTrigger>
              <TabsTrigger value="month">Month</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              disabled={zoom === 'month'}
              onClick={() => setZoom(zoom === 'day' ? 'week' : 'month')}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              disabled={zoom === 'day'}
              onClick={() => setZoom(zoom === 'month' ? 'week' : 'day')}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex">
        {/* Task pane */}
        <div className="w-64 shrink-0 border-r border-border sm:w-80">
          <div className="flex h-12 items-end border-b border-border px-3 pb-1.5">
            <span className="epm-eyebrow">Task</span>
            <span className="epm-eyebrow ml-auto hidden sm:block">Status</span>
          </div>
          {milestones.length > 0 ? (
            <div
              style={{ height: MILESTONE_LANE }}
              className="flex items-center border-b border-border px-3"
            >
              <span className="epm-eyebrow">Milestones</span>
            </div>
          ) : null}
          {scheduled.map((task) => (
            <div
              key={task.id}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center gap-2 border-b border-border px-3 last:border-b-0"
            >
              <UserAvatarWithTooltip
                user={task.assigneeId ? users.get(task.assigneeId) : undefined}
                size="xs"
              />
              <Link
                to={`/tasks/${task.id}`}
                className="min-w-0 flex-1 truncate text-xs text-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {task.subject}
              </Link>
              <StatusBadge status={task.statusCategory} size="sm" className="hidden shrink-0 sm:inline-flex" />
            </div>
          ))}
        </div>

        {/* Timeline pane */}
        <div ref={scrollRef} className="epm-scroll flex-1 overflow-x-auto">
          <div style={{ width: totalWidth, minWidth: '100%' }} className="relative">
            {/* Scale */}
            <div className="sticky top-0 z-10 h-12 border-b border-border bg-surface">
              <div className="relative h-6 border-b border-border">
                {monthBands.map((band) => (
                  <span
                    key={`${band.label}-${band.offset}`}
                    style={{ left: band.offset, width: band.width }}
                    className="absolute flex h-6 items-center overflow-hidden whitespace-nowrap border-l border-border px-2 text-2xs font-medium text-foreground"
                  >
                    {band.label}
                  </span>
                ))}
              </div>
              <div className="relative h-6">
                {days.map((date, index) => {
                  const showLabel =
                    zoom === 'day' || (zoom === 'week' && date.getDay() === 1) || date.getDate() === 1;
                  return (
                    <span
                      key={date.toISOString()}
                      style={{ left: index * columnWidth, width: columnWidth }}
                      className={cn(
                        'absolute flex h-6 items-center justify-center text-2xs',
                        isWeekend(date) ? 'text-muted-foreground/50' : 'text-muted-foreground',
                        isSameDay(date, today) && 'font-semibold text-danger',
                      )}
                    >
                      {showLabel ? format(date, 'd') : ''}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Weekend shading */}
            <div className="pointer-events-none absolute inset-0 top-12" aria-hidden>
              {days.map((date, index) =>
                isWeekend(date) ? (
                  <span
                    key={date.toISOString()}
                    style={{ left: index * columnWidth, width: columnWidth }}
                    className="absolute inset-y-0 bg-muted/50"
                  />
                ) : null,
              )}
            </div>

            {/* Today marker */}
            {todayOffset >= 0 && todayOffset <= totalWidth ? (
              <div
                style={{ left: todayOffset }}
                className="pointer-events-none absolute inset-y-0 top-12 z-10 w-px bg-danger"
                aria-hidden
              />
            ) : null}

            {/* Milestone lane */}
            {milestones.length > 0 ? (
              <div
                style={{ height: MILESTONE_LANE }}
                className="relative border-b border-border"
              >
                {milestones.map((milestone) => {
                  const offset =
                    differenceInCalendarDays(parseISO(milestone.date), range.start) * columnWidth;
                  if (offset < 0 || offset > totalWidth) return null;
                  return (
                    <Tooltip key={milestone.id}>
                      <TooltipTrigger asChild>
                        <span
                          style={{ left: offset - 5 }}
                          className="absolute top-1/2 z-10 -translate-y-1/2 cursor-default"
                        >
                          <Diamond
                            className={cn(
                              'h-2.5 w-2.5',
                              milestone.status === 'completed'
                                ? 'fill-success text-success'
                                : 'fill-warning text-warning',
                            )}
                          />
                          <span className="sr-only">{milestone.name} milestone</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {milestone.name} · {formatShortDate(milestone.date)}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}

            {/* Bars */}
            <div className="relative">
              {scheduled.map((task, rowIndex) => {
                const start = parseISO(task.startDate!);
                const end = parseISO(task.dueDate!);
                const offset = differenceInCalendarDays(start, range.start) * columnWidth;
                const width = Math.max(
                  columnWidth,
                  (differenceInCalendarDays(end, start) + 1) * columnWidth,
                );
                const tone = TASK_STATUS_META[task.statusCategory].tone;

                // Dependency link to the previous row, drawn when it finishes first.
                const previous = scheduled[rowIndex - 1];
                const showLink =
                  previous?.dueDate && parseISO(previous.dueDate) <= start && rowIndex > 0;
                const previousEndOffset = previous?.dueDate
                  ? (differenceInCalendarDays(parseISO(previous.dueDate), range.start) + 1) *
                    columnWidth
                  : 0;

                return (
                  <div
                    key={task.id}
                    style={{ height: ROW_HEIGHT }}
                    className="relative border-b border-border last:border-b-0"
                  >
                    {showLink ? (
                      <svg
                        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                        aria-hidden
                      >
                        <path
                          d={`M ${previousEndOffset} ${-ROW_HEIGHT / 2} H ${offset - 6} V ${ROW_HEIGHT / 2} h 4`}
                          fill="none"
                          stroke="hsl(var(--border))"
                          strokeWidth={1}
                        />
                      </svg>
                    ) : null}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          to={`/tasks/${task.id}`}
                          style={{ left: offset, width }}
                          className={cn(
                            'absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-2xs font-medium leading-none text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            TONE_FILL[tone],
                          )}
                        >
                          {/* A one-day bar is too narrow for a legible key. */}
                          {width >= 44 ? <span className="truncate">{task.key}</span> : null}
                          {task.progress > 0 && task.progress < 100 ? (
                            <span
                              style={{ width: `${task.progress}%` }}
                              className="absolute inset-y-0 left-0 bg-foreground/15"
                              aria-hidden
                            />
                          ) : null}
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="block font-semibold">{task.subject}</span>
                        <span className="block">
                          {formatShortDate(task.startDate)} — {formatShortDate(task.dueDate)} ·{' '}
                          {formatPercent(task.progress)} complete
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}

            </div>
          </div>
        </div>
      </div>

      <Pagination
        page={paged.page}
        pageSize={paged.pageSize}
        total={paged.total}
        onPageChange={paged.setPage}
        onPageSizeChange={paged.setPageSize}
        pageSizeOptions={[15, 30, 50]}
        itemLabel="scheduled item"
        className="border-t border-border"
      />
    </Card>
  );
}

export function GanttChartSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-3 py-2.5">
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="flex">
        <div className="w-64 shrink-0 space-y-3 border-r border-border p-3 sm:w-80">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-4 w-full" />
          ))}
        </div>
        <div className="flex-1 space-y-3 p-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-4"
              style={{ width: `${35 + ((index * 13) % 50)}%`, marginLeft: `${(index * 7) % 30}%` }}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}
