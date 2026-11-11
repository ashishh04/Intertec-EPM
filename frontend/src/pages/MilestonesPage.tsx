import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addMonths, differenceInCalendarDays, format, parseISO, startOfMonth } from 'date-fns';
import { CalendarCheck2, CalendarClock, CalendarX2, ChevronLeft, ChevronRight, Flag, Milestone as MilestoneIcon } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePagination } from '@/hooks/usePagination';
import { useProjects } from '@/hooks/useProjects';
import { useMilestones } from '@/hooks/useRisks';
import type { Tone } from '@/lib/domain';
import { intlLocale, isRightToLeft, t } from '@/lib/i18n';
import { cn, formatPercent, formatShortDate } from '@/lib/utils';
import type { EpmProject, MilestoneEntry } from '@/types';

/**
 * Milestones across every project the reader can see, on one timeline.
 *
 * Each row is a milestone: its project, the project's schedule health and how
 * far the project has got, and a diamond on its date, coloured by where it
 * stands. The line is today. The window is a few months, moved with the
 * arrows, or fitted to every milestone shown.
 */

const ALL = '__all__';
const SOON_DAYS = 30;
const PAGE_SIZE = 25;

type Zoom = 'fit' | '3' | '6' | '12';
type Standing = 'completed' | 'overdue' | 'soon' | 'upcoming' | 'undated';

const STANDING_TONE: Record<Standing, Tone> = {
  completed: 'success',
  overdue: 'danger',
  soon: 'warning',
  upcoming: 'primary',
  undated: 'neutral',
};

const DIAMOND: Record<Standing, string> = {
  completed: 'bg-success',
  overdue: 'bg-danger',
  soon: 'bg-warning',
  upcoming: 'bg-primary',
  undated: 'bg-muted-foreground',
};

function standingLabel(standing: Standing): string {
  switch (standing) {
    case 'completed':
      return t('Completed');
    case 'overdue':
      return t('Overdue');
    case 'soon':
      return t('Due soon');
    case 'upcoming':
      return t('Upcoming');
    default:
      return t('No date');
  }
}

const isoDay = (date: Date) => format(date, 'yyyy-MM-dd');

export default function MilestonesPage() {
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('project') ?? ALL;
  const state = (['open', 'closed', 'all'].includes(search.get('state') ?? '') ? search.get('state') : 'all') as
    | 'open'
    | 'closed'
    | 'all';
  const zoom = (['fit', '3', '6', '12'].includes(search.get('zoom') ?? '') ? search.get('zoom') : '6') as Zoom;
  const [text, setText] = useState('');
  // Months from this month to the window's first: the arrows move it.
  const [shift, setShift] = useState(-1);

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next, { replace: true });
  };

  const milestones = useMilestones({ projectId: projectId === ALL ? undefined : projectId });
  const projects = useProjects();
  const projectById = useMemo(
    () => new Map<string, EpmProject>((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );

  const today = isoDay(new Date());
  const soonUntil = isoDay(new Date(Date.now() + (SOON_DAYS - 1) * 86_400_000));

  const standingOf = (entry: MilestoneEntry): Standing => {
    if (entry.closed) return 'completed';
    if (!entry.date) return 'undated';
    if (entry.date < today) return 'overdue';
    if (entry.date <= soonUntil) return 'soon';
    return 'upcoming';
  };

  const all = milestones.data ?? [];
  const counts = {
    soon: all.filter((entry) => standingOf(entry) === 'soon').length,
    overdue: all.filter((entry) => standingOf(entry) === 'overdue').length,
    completed: all.filter((entry) => entry.closed).length,
    undated: all.filter((entry) => standingOf(entry) === 'undated').length,
  };

  const needle = text.trim().toLowerCase();
  const shown = all
    .filter((entry) => (state === 'all' ? true : state === 'open' ? !entry.closed : entry.closed))
    .filter(
      (entry) =>
        !needle ||
        entry.name.toLowerCase().includes(needle) ||
        (projectById.get(entry.projectId)?.name.toLowerCase().includes(needle) ?? false),
    );

  // The window the timeline draws: whole months, or fitted to the milestones.
  const range = useMemo(() => {
    if (zoom === 'fit') {
      const dates = shown.map((entry) => entry.date).filter((date): date is string => Boolean(date));
      const first = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today;
      const last = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today;
      const start = startOfMonth(parseISO(first < today ? first : today));
      const end = addMonths(startOfMonth(parseISO(last > today ? last : today)), 1);
      return { start, end };
    }
    const start = addMonths(startOfMonth(new Date()), shift);
    return { start, end: addMonths(start, Number(zoom)) };
  }, [zoom, shift, shown, today]);

  const span = Math.max(1, differenceInCalendarDays(range.end, range.start));
  const position = (date: string) => (differenceInCalendarDays(parseISO(date), range.start) / span) * 100;
  const todayAt = position(today);

  // Month marks, or quarters when there would be too many to read.
  const marks = useMemo(() => {
    const months: Date[] = [];
    for (let at = range.start; at < range.end; at = addMonths(at, 1)) months.push(at);
    const step = months.length > 18 ? 3 : 1;
    const label = new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' });
    return months
      .filter((_, index) => index % step === 0)
      .map((at) => ({ at: (differenceInCalendarDays(at, range.start) / span) * 100, label: label.format(at), key: isoDay(at) }));
  }, [range, span]);

  const paged = usePagination(shown, { pageSize: PAGE_SIZE, resetKey: `${projectId}|${state}|${needle}` });
  const step = zoom === 'fit' ? 0 : Math.max(1, Number(zoom) / 3);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Milestones')}
        description={t('Every project’s milestones on one timeline, with each project’s schedule health and progress.')}
      />

      <QueryBoundary
        isLoading={milestones.isLoading}
        isError={milestones.isError}
        error={milestones.error}
        onRetry={() => milestones.refetch()}
        errorTitle={t('Unable to load milestones')}
        skeleton={
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <MetricCardSkeleton key={index} />
              ))}
            </div>
            <Skeleton className="h-80 w-full rounded-lg" />
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label={t('Due in the next 30 days')}
              value={counts.soon}
              icon={CalendarClock}
              tone="warning"
              onClick={() => update({ state: 'open' })}
            />
            <MetricCard
              label={t('Overdue')}
              value={counts.overdue}
              icon={CalendarX2}
              tone={counts.overdue > 0 ? 'danger' : 'success'}
              support={t('Open past their date')}
              onClick={() => update({ state: 'open' })}
            />
            <MetricCard
              label={t('Completed')}
              value={counts.completed}
              icon={CalendarCheck2}
              tone="success"
              onClick={() => update({ state: 'closed' })}
            />
            <MetricCard label={t('No date set')} value={counts.undated} icon={Flag} tone="neutral" />
          </div>

          <ListToolbar
            trailing={<ResultCount count={shown.length} total={all.length} label={t('milestone')} plural={t('milestones')} />}
          >
            <SearchInput
              value={text}
              onValueChange={setText}
              placeholder={t('Search milestones')}
              aria-label={t('Search milestones')}
            />
            <Select value={projectId} onValueChange={(value) => update({ project: value })}>
              <SelectTrigger className="h-8 w-48 text-xs" aria-label={t('Filter by project')}>
                <SelectValue placeholder={t('All projects')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('All projects')}</SelectItem>
                {(projects.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={(value) => update({ state: value === 'all' ? undefined : value })}>
              <SelectTrigger className="h-8 w-32 text-xs" aria-label={t('Filter by state')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All')}</SelectItem>
                <SelectItem value="open">{t('Open')}</SelectItem>
                <SelectItem value="closed">{t('Completed')}</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Select value={zoom} onValueChange={(value) => update({ zoom: value === '6' ? undefined : value })}>
                <SelectTrigger className="h-8 w-32 text-xs" aria-label={t('Timeline zoom')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">{t('Fit')}</SelectItem>
                  <SelectItem value="3">{t('3 months')}</SelectItem>
                  <SelectItem value="6">{t('6 months')}</SelectItem>
                  <SelectItem value="12">{t('12 months')}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('Earlier')}
                disabled={zoom === 'fit'}
                onClick={() => setShift((value) => value - step)}
              >
                {isRightToLeft() ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
              </Button>
              <Button size="sm" variant="ghost" disabled={zoom === 'fit'} onClick={() => setShift(-1)}>
                {t('Today')}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('Later')}
                disabled={zoom === 'fit'}
                onClick={() => setShift((value) => value + step)}
              >
                {isRightToLeft() ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </Button>
            </div>
          </ListToolbar>

          {shown.length === 0 ? (
            <Card>
              <EmptyState
                icon={MilestoneIcon}
                title={all.length === 0 ? t('No milestones yet') : t('No milestones match')}
                description={
                  all.length === 0
                    ? t('A milestone is a work item of a milestone type in its project, with one date.')
                    : t('Change the filters to see more.')
                }
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {/* Header: the columns, then the months across the timeline. */}
              <div className="flex border-b border-border bg-muted/40 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                <div className="flex w-full shrink-0 items-center gap-3 px-4 py-2 md:w-[30rem]">
                  <span className="min-w-0 flex-1">{t('Milestone')}</span>
                  <span className="w-20 shrink-0">{t('Date')}</span>
                  <span className="hidden w-24 shrink-0 lg:block" title={t('The project’s schedule health')}>
                    {t('Schedule')}
                  </span>
                  <span className="hidden w-12 shrink-0 text-end lg:block" title={t('How far the project has got')}>
                    {t('Done')}
                  </span>
                </div>
                <div className="relative hidden flex-1 border-s border-border md:block">
                  {marks.map((mark) => (
                    <span
                      key={mark.key}
                      className="absolute top-0 flex h-full items-center border-s border-border/70 ps-1.5 normal-case tracking-normal"
                      style={{ insetInlineStart: `${mark.at}%` }}
                    >
                      {mark.label}
                    </span>
                  ))}
                </div>
              </div>

              <ul>
                {paged.items.map((entry) => {
                  const project = projectById.get(entry.projectId);
                  const standing = standingOf(entry);
                  const at = entry.date ? position(entry.date) : null;
                  return (
                    <li key={entry.id} className="flex border-b border-border last:border-b-0 hover:bg-muted/30">
                      <div className="flex w-full shrink-0 items-center gap-3 px-4 py-2 md:w-[30rem]">
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/tasks/${entry.id}`}
                            className="block truncate text-sm font-medium hover:text-primary"
                            dir="auto"
                          >
                            {entry.name}
                          </Link>
                          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                            <Badge tone={STANDING_TONE[standing]} size="sm" dot>
                              {standingLabel(standing)}
                            </Badge>
                            <Link to={`/projects/${entry.projectId}`} className="truncate hover:text-primary" dir="auto">
                              {project?.name ?? t('Project')}
                            </Link>
                          </span>
                        </div>
                        <span className="w-20 shrink-0 whitespace-nowrap text-xs tabular-nums">
                          {entry.date ? formatShortDate(entry.date) : '—'}
                        </span>
                        <span className="hidden w-24 shrink-0 lg:flex">
                          <HealthIndicator level={project?.health.schedule ?? null} className="whitespace-nowrap" />
                        </span>
                        <span className="hidden w-12 shrink-0 text-end text-xs tabular-nums lg:block">
                          {project ? formatPercent(project.progress) : '—'}
                        </span>
                      </div>

                      <div className="relative hidden min-h-12 flex-1 border-s border-border md:block">
                        {marks.map((mark) => (
                          <span
                            key={mark.key}
                            className="absolute inset-y-0 border-s border-border/40"
                            style={{ insetInlineStart: `${mark.at}%` }}
                            aria-hidden
                          />
                        ))}
                        {todayAt >= 0 && todayAt <= 100 ? (
                          <span
                            className="absolute inset-y-0 w-px bg-primary/70"
                            style={{ insetInlineStart: `${todayAt}%` }}
                            aria-hidden
                          />
                        ) : null}
                        {at === null ? null : at < 0 || at > 100 ? (
                          // Outside the window: a mark at the edge it lies beyond.
                          <span
                            className="absolute top-1/2 -translate-y-1/2 text-2xs text-muted-foreground"
                            style={at < 0 ? { insetInlineStart: 4 } : { insetInlineEnd: 4 }}
                          >
                            {at < 0 ? (isRightToLeft() ? '›' : '‹') : isRightToLeft() ? '‹' : '›'}{' '}
                            {formatShortDate(entry.date)}
                          </span>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                tabIndex={0}
                                className={cn(
                                  'absolute top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 rounded-[2px] shadow-sm ring-2 ring-surface',
                                  'focus-visible:outline-none focus-visible:ring-ring',
                                  DIAMOND[standing],
                                )}
                                style={{ insetInlineStart: `calc(${at}% - 6px)` }}
                                aria-label={t('{name}, {date}: {standing}', {
                                  name: entry.name,
                                  date: formatShortDate(entry.date),
                                  standing: standingLabel(standing),
                                })}
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <span className="block font-medium">{entry.name}</span>
                              <span className="block text-2xs opacity-80">
                                {formatShortDate(entry.date)} · {standingLabel(standing)}
                                {entry.statusName ? ` · ${entry.statusName}` : ''}
                              </span>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {shown.length > PAGE_SIZE ? (
                <div className="border-t border-border">
                  <Pagination
                    page={paged.page}
                    pageSize={paged.pageSize}
                    total={paged.total}
                    onPageChange={paged.setPage}
                    onPageSizeChange={paged.setPageSize}
                    pageSizeOptions={[25, 50, 100]}
                    itemLabel={t('milestone')}
                    itemLabelPlural={t('milestones')}
                  />
                </div>
              ) : null}
            </Card>
          )}

          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            {(['overdue', 'soon', 'upcoming', 'completed'] as Standing[]).map((standing) => (
              <span key={standing} className="inline-flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rotate-45 rounded-[2px]', DIAMOND[standing])} aria-hidden />
                {standingLabel(standing)}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-px bg-primary/70" aria-hidden />
              {t('Today')}
            </span>
          </p>
        </div>
      </QueryBoundary>
    </div>
  );
}
