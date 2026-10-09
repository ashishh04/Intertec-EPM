import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { AlertTriangle, Diamond, Loader2, Route, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { StatusBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { floatBand, floatLabel, NEAR_CRITICAL_CHOICES, type FloatBand } from '@/lib/critical-path';
import { TASK_STATUS_META, TONE_FILL } from '@/lib/domain';
import { cn, formatPercent, formatRelative, formatShortDate } from '@/lib/utils';
import type { ID, Milestone, EpmTask, EpmUser, ProjectCriticalPath, ScheduleItem } from '@/types';

type ZoomLevel = 'day' | 'week' | 'month';

const COLUMN_WIDTH: Record<ZoomLevel, number> = { day: 34, week: 14, month: 5 };
const ROW_HEIGHT = 34;
/** Height of the milestone strip that sits above the task bars. */
const MILESTONE_LANE = 22;

/** Bar fill on the critical path view, by band. */
const BAND_FILL: Record<FloatBand, string> = {
  critical: 'bg-danger',
  near: 'bg-warning',
  other: 'bg-muted-foreground/35',
};

interface GanttChartProps {
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  milestones?: Milestone[];
  /**
   * Float and the relations between the work, when EPM computes them
   * (BR-101, BR-102). Without it the chart draws bars and milestones only.
   */
  schedule?: ProjectCriticalPath;
  className?: string;
}

/**
 * Timeline view of scheduled work.
 *
 * The left pane lists the work packages, the right pane draws their bars on a
 * shared date scale with a today marker, weekend shading, milestone diamonds
 * and the `follows` relations between them, as arrows from a predecessor's
 * finish to its successor's start.
 *
 * The critical path view (BR-102) recolours the bars by total float: critical
 * work — no float — in red, near-critical work — float at or below the chosen
 * threshold — in amber, the rest muted, with each bar's slack drawn after it
 * and the relations that drive the critical path in red. Its settings live in
 * the address, so a highlighted view can be shared as a link.
 */
export function GanttChart({ tasks, users, milestones = [], schedule, className }: GanttChartProps) {
  const [zoom, setZoom] = useState<ZoomLevel>('week');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [params, setParams] = useSearchParams();

  const available = Boolean(schedule?.enabled);
  const criticalOn = available && params.get('cp') === '1';
  const askedNear = Number(params.get('near'));
  const threshold =
    params.get('near') !== null && Number.isInteger(askedNear) && askedNear >= 0
      ? askedNear
      : (schedule?.defaultNearCriticalDays ?? 2);
  const onlyHighlighted = criticalOn && params.get('cpOnly') === '1';

  const setView = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  const figures = useMemo(
    () => new Map<ID, ScheduleItem>((schedule?.items ?? []).map((item) => [item.id, item])),
    [schedule],
  );
  const bandOf = (id: ID): FloatBand | undefined => (criticalOn ? floatBand(figures.get(id), threshold) : undefined);

  const allScheduled = useMemo(() => {
    const dated = tasks.filter((task) => task.startDate && task.dueDate);
    if (!onlyHighlighted) return dated;
    return dated.filter((task) => {
      const band = floatBand(figures.get(task.id), threshold);
      return band === 'critical' || band === 'near';
    });
  }, [tasks, onlyHighlighted, figures, threshold]);

  // What the highlight covers, over every dated task — not just this page.
  const counts = useMemo(() => {
    let critical = 0;
    let near = 0;
    for (const task of tasks) {
      if (!task.startDate || !task.dueDate) continue;
      const band = floatBand(figures.get(task.id), threshold);
      if (band === 'critical') critical += 1;
      else if (band === 'near') near += 1;
    }
    return { critical, near };
  }, [tasks, figures, threshold]);

  // The date scale spans the whole plan; only the rows page, so scrolling the
  // timeline never means scrolling past dozens of task rows.
  const paged = usePagination(allScheduled, {
    pageSize: 15,
    resetKey: `${zoom}|${onlyHighlighted ? threshold : 'all'}`,
  });
  const scheduled = paged.items;

  const range = useMemo(() => {
    if (allScheduled.length === 0) {
      const today = new Date();
      return { start: startOfMonth(today), end: endOfMonth(addDays(today, 30)) };
    }
    const starts = allScheduled.map((task) => parseISO(task.startDate!));
    const ends = allScheduled.map((task) => parseISO(task.dueDate!));
    const milestoneDates = milestones.map((milestone) => parseISO(milestone.date));
    // The slack drawn after a bar reaches its late finish, which can lie past every due date.
    const lateFinishes = criticalOn
      ? allScheduled.flatMap((task) => {
          const item = figures.get(task.id);
          return item ? [parseISO(item.lateFinish)] : [];
        })
      : [];

    return {
      start: startOfWeek(minDate([...starts, ...milestoneDates, new Date()]), { weekStartsOn: 1 }),
      end: addDays(maxDate([...ends, ...milestoneDates, ...lateFinishes, new Date()]), 3),
    };
  }, [allScheduled, milestones, criticalOn, figures]);

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

  // Where each bar on this page sits, for the relation arrows.
  const geometry = useMemo(() => {
    const byId = new Map<ID, { row: number; left: number; right: number }>();
    scheduled.forEach((task, row) => {
      const start = parseISO(task.startDate!);
      const end = parseISO(task.dueDate!);
      const left = differenceInCalendarDays(start, range.start) * columnWidth;
      const width = Math.max(columnWidth, (differenceInCalendarDays(end, start) + 1) * columnWidth);
      byId.set(task.id, { row, left, right: left + width });
    });
    return byId;
  }, [scheduled, range, columnWidth]);

  // Only relations with both ends on this page can be drawn.
  const arrows = useMemo(
    () =>
      (schedule?.links ?? []).flatMap((link) => {
        const from = geometry.get(link.predecessorId);
        const to = geometry.get(link.successorId);
        if (!from || !to) return [];
        const y1 = from.row * ROW_HEIGHT + ROW_HEIGHT / 2;
        const y2 = to.row * ROW_HEIGHT + ROW_HEIGHT / 2;
        const gap = 6;
        const path =
          to.left - from.right >= gap * 2
            ? `M ${from.right} ${y1} H ${from.right + gap} V ${y2} H ${to.left - 1}`
            : `M ${from.right} ${y1} h ${gap} V ${(y1 + y2) / 2} H ${to.left - gap} V ${y2} H ${to.left - 1}`;
        return [{ id: link.id, path, critical: criticalOn && link.critical }];
      }),
    [schedule, geometry, criticalOn],
  );

  if (allScheduled.length === 0 && !onlyHighlighted) {
    return (
      <Card className={className}>
        <EmptyState
          title="Nothing scheduled yet"
          description="Work packages need a start and due date before they appear on the timeline."
        />
      </Card>
    );
  }

  const thresholdChoices = [...new Set([...NEAR_CRITICAL_CHOICES, threshold, schedule?.defaultNearCriticalDays ?? 2])].sort(
    (a, b) => a - b,
  );
  const cycleMembers = new Set((schedule?.cycles ?? []).flat());

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
          {criticalOn ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
                Critical
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
                Near-critical, {threshold === 0 ? 'none' : `float ≤ ${threshold} ${threshold === 1 ? 'day' : 'days'}`}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/35" aria-hidden />
                Other
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-px w-4 bg-muted-foreground" aria-hidden />
                Float
              </span>
            </>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
              Scheduled work
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Diamond className="h-3 w-3 fill-warning text-warning" aria-hidden />
            Milestone
          </span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <span className="h-3 w-px bg-danger" aria-hidden />
            Today
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <InfoTooltip
            label={
              available
                ? 'Colour the bars by total float: the work whose slip moves the project finish, and the work close to it.'
                : 'Float is not computed on this server.'
            }
          >
            <span>
              <Button
                variant={criticalOn ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={criticalOn}
                disabled={!available}
                onClick={() => setView({ cp: criticalOn ? null : '1', cpOnly: null })}
              >
                <Route className="h-3.5 w-3.5" />
                Critical path
              </Button>
            </span>
          </InfoTooltip>
          {criticalOn ? (
            <>
              <Select value={String(threshold)} onValueChange={(value) => setView({ near: value })}>
                <SelectTrigger className="h-8 w-40" aria-label="Near-critical threshold: total float of at most">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {thresholdChoices.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days === 0 ? 'Critical only' : `Float ≤ ${days} ${days === 1 ? 'day' : 'days'}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                <Checkbox
                  checked={onlyHighlighted}
                  onCheckedChange={(checked) => setView({ cpOnly: checked === true ? '1' : null })}
                  aria-label="Show only critical and near-critical work"
                />
                Highlighted only
              </label>
            </>
          ) : null}
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

      {criticalOn ? (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-3 py-1.5 text-2xs text-muted-foreground"
          data-testid="critical-path-summary"
        >
          <span>
            <span className="font-semibold text-danger" data-count="critical">
              {counts.critical}
            </span>{' '}
            critical ·{' '}
            <span className="font-semibold text-warning-strong" data-count="near">
              {counts.near}
            </span>{' '}
            near-critical
          </span>
          {schedule?.finish ? <span>Finish on the critical path: {formatShortDate(schedule.finish)}</span> : null}
          {schedule?.computedAt ? <span>Float computed {formatRelative(schedule.computedAt)}</span> : null}
          {schedule?.pending ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Recalculating
            </span>
          ) : null}
          {cycleMembers.size > 0 ? (
            <span className="flex items-center gap-1 text-warning-strong">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {cycleMembers.size} work packages are in a loop of dependencies; their float ignores the relations between them.
            </span>
          ) : null}
        </div>
      ) : null}

      {allScheduled.length === 0 ? (
        <EmptyState
          title="Nothing within the threshold"
          description="No scheduled work has total float at or below it. Raise the threshold, or show all the work."
        />
      ) : (
        <div className="flex">
          {/* Task pane */}
          <div className="w-64 shrink-0 border-r border-border sm:w-80">
            <div className="flex h-12 items-end border-b border-border px-3 pb-1.5">
              <span className="epm-eyebrow">Task</span>
              <span className="epm-eyebrow ml-auto hidden sm:block">{criticalOn ? 'Float' : 'Status'}</span>
            </div>
            {milestones.length > 0 ? (
              <div
                style={{ height: MILESTONE_LANE }}
                className="flex items-center border-b border-border px-3"
              >
                <span className="epm-eyebrow">Milestones</span>
              </div>
            ) : null}
            {scheduled.map((task) => {
              const item = figures.get(task.id);
              const band = bandOf(task.id);
              return (
                <div
                  key={task.id}
                  style={{ height: ROW_HEIGHT }}
                  className="flex items-center gap-2 border-b border-border px-3 last:border-b-0"
                  data-task-id={task.id}
                  data-float-band={band ?? undefined}
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
                  {criticalOn ? (
                    <span
                      className={cn(
                        'hidden shrink-0 rounded px-1.5 py-0.5 font-mono text-2xs sm:inline',
                        band === 'critical'
                          ? 'bg-danger-soft text-danger'
                          : band === 'near'
                            ? 'bg-warning-soft text-warning-strong'
                            : 'text-muted-foreground',
                      )}
                      title={item ? `Total float: ${floatLabel(item.totalFloat)}` : 'Not computed yet'}
                    >
                      {item ? `${item.totalFloat}d` : '—'}
                    </span>
                  ) : (
                    <StatusBadge status={task.statusCategory} size="sm" className="hidden shrink-0 sm:inline-flex" />
                  )}
                </div>
              );
            })}
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
                {/* Relations: from a predecessor's finish to its successor's start. */}
                {arrows.length > 0 ? (
                  <svg
                    className="pointer-events-none absolute left-0 top-0 overflow-visible"
                    width={totalWidth}
                    height={scheduled.length * ROW_HEIGHT}
                    aria-hidden
                  >
                    <defs>
                      <marker id="gantt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M0,0 L6,3 L0,6 z" fill="hsl(var(--muted-foreground))" />
                      </marker>
                      <marker id="gantt-arrow-critical" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M0,0 L6,3 L0,6 z" fill="hsl(var(--danger))" />
                      </marker>
                    </defs>
                    {arrows.map((arrow) => (
                      <path
                        key={arrow.id}
                        d={arrow.path}
                        fill="none"
                        stroke={arrow.critical ? 'hsl(var(--danger))' : 'hsl(var(--muted-foreground))'}
                        strokeOpacity={arrow.critical ? 1 : 0.55}
                        strokeWidth={arrow.critical ? 1.5 : 1}
                        markerEnd={`url(#${arrow.critical ? 'gantt-arrow-critical' : 'gantt-arrow'})`}
                        data-critical={arrow.critical ? 'true' : undefined}
                      />
                    ))}
                  </svg>
                ) : null}

                {scheduled.map((task) => {
                  const start = parseISO(task.startDate!);
                  const end = parseISO(task.dueDate!);
                  const offset = differenceInCalendarDays(start, range.start) * columnWidth;
                  const width = Math.max(
                    columnWidth,
                    (differenceInCalendarDays(end, start) + 1) * columnWidth,
                  );
                  const tone = TASK_STATUS_META[task.statusCategory].tone;
                  const item = figures.get(task.id);
                  const band = bandOf(task.id);
                  // Slack: from where the work could finish to where it must.
                  const slack =
                    criticalOn && item && item.totalFloat > 0
                      ? {
                          left: (differenceInCalendarDays(parseISO(item.earlyFinish), range.start) + 1) * columnWidth,
                          right: (differenceInCalendarDays(parseISO(item.lateFinish), range.start) + 1) * columnWidth,
                        }
                      : undefined;

                  return (
                    <div
                      key={task.id}
                      style={{ height: ROW_HEIGHT }}
                      className="relative border-b border-border last:border-b-0"
                    >
                      {slack && slack.right > slack.left ? (
                        <span
                          style={{ left: slack.left, width: slack.right - slack.left }}
                          className="pointer-events-none absolute top-1/2 h-px bg-muted-foreground/70"
                          aria-hidden
                        >
                          <span className="absolute -top-1 right-0 h-2 w-px bg-muted-foreground/70" />
                        </span>
                      ) : null}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            to={`/tasks/${task.id}`}
                            style={{ left: offset, width }}
                            data-task-id={task.id}
                            data-float-band={band ?? undefined}
                            className={cn(
                              'absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-2xs font-medium leading-none text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              criticalOn ? BAND_FILL[band ?? 'other'] : TONE_FILL[tone],
                              criticalOn && cycleMembers.has(task.id) && 'ring-2 ring-warning ring-offset-1',
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
                          {item ? (
                            <>
                              <span className="block">
                                {item.critical ? 'On the critical path · ' : ''}Total float {floatLabel(item.totalFloat)} ·
                                free float {floatLabel(item.freeFloat)}
                              </span>
                              <span className="block text-muted-foreground">
                                Early {formatShortDate(item.earlyStart)} — {formatShortDate(item.earlyFinish)} · late{' '}
                                {formatShortDate(item.lateStart)} — {formatShortDate(item.lateFinish)}
                              </span>
                            </>
                          ) : null}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <Pagination
        page={paged.page}
        pageSize={paged.pageSize}
        total={paged.total}
        onPageChange={paged.setPage}
        onPageSizeChange={paged.setPageSize}
        pageSizeOptions={[15, 30, 50, 100]}
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
