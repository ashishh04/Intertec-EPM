import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Info } from 'lucide-react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useResourceRoles, useCapacity } from '@/hooks/useResources';
import { useTeams } from '@/hooks/useTeams';
import { useDepartments } from '@/hooks/useDepartments';
import { t } from '@/lib/i18n';
import { cn, formatRelative, formatShortDate } from '@/lib/utils';
import type { CapacityQuery } from '@/services/api/resources';
import type { CapacityBand, CapacityCell, CapacityGrouping, CapacityMeasure, CapacityPeriod, CapacityScale } from '@/types';
import { BAND_CELL, BAND_LABEL, bandRange, hours, percent } from './bands';
import { CellDetailSheet } from './CellDetailSheet';
import { currentName, firstDay, LENGTHS, monthOf, spanOf, weekdayOf } from './periods';

const BANDS: CapacityBand[] = ['under', 'healthy', 'full', 'over'];
const stickyCell = 'sticky start-0 z-10 bg-surface';

const isScale = (value: unknown): value is CapacityScale => value === 'day' || value === 'week' || value === 'month';

/**
 * The capacity heatmap and forecast (BR-313, BR-314): people — and, when the
 * work assigned counts, the placeholders and roles booked with nobody named —
 * by day, week or month, each cell a share of the hours they have, coloured by
 * the instance's thresholds. Unless asked otherwise it counts the time people
 * logged alone: someone is as busy as their timesheet says, not as the work
 * assigned to them. Every cell opens on what is behind it.
 */
export function CapacityHeatmap() {
  // What the viewer chose last, remembered in this browser.
  const [storedMeasure, setMeasure] = useLocalStorage<string>('epm.capacity.measure', 'logged');
  const [storedScale, setScale] = useLocalStorage<string>('epm.capacity.scale', 'day');
  const measure: CapacityMeasure = storedMeasure === 'assigned' ? 'assigned' : 'logged';
  const scale: CapacityScale = isScale(storedScale) ? storedScale : 'day';
  const [count, setCount] = useState(LENGTHS[scale].usual);
  const [offset, setOffset] = useState(0);
  const [group, setGroup] = useState<CapacityGrouping>('team');
  const [teamId, setTeamId] = useState<string>();
  const [roleId, setRoleId] = useState<string>();
  const [departmentId, setDepartmentId] = useState<string>();
  const [placeholders, setPlaceholders] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cell, setCell] = useState<{ key: string; week: string } | null>(null);

  const query: CapacityQuery = useMemo(
    () => ({
      from: firstDay(scale, count, measure, offset),
      count,
      scale,
      measure,
      group,
      teamId,
      roleId,
      departmentId,
      // Placeholders log no time: they only show beside the work assigned.
      placeholders: measure === 'assigned' ? placeholders : undefined,
    }),
    [scale, count, measure, offset, group, teamId, roleId, departmentId, placeholders],
  );
  const grid = useCapacity(query);
  const teams = useTeams();
  const roles = useResourceRoles();
  const departments = useDepartments();

  const chooseScale = (next: CapacityScale) => {
    setScale(next);
    setCount(LENGTHS[next].usual);
    setOffset(0);
  };
  const chooseMeasure = (next: CapacityMeasure) => {
    setMeasure(next);
    setOffset(0);
  };
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const data = grid.data;
  // A grid read before periods were sent has weeks alone.
  const periods: CapacityPeriod[] = data ? (data.periods ?? data.weeks.map((start) => ({ start, end: start }))) : [];
  const shown = data?.scale ?? scale;
  const logged = (data?.measure ?? measure) === 'logged';
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="capacity-measure">{t('Based on')}</Label>
            <Select value={measure} onValueChange={(value) => chooseMeasure(value as CapacityMeasure)}>
              <SelectTrigger id="capacity-measure" className="w-60" data-testid="capacity-measure">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="logged">{t('Logged time only')}</SelectItem>
                <SelectItem value="assigned">{t('Logged time and assigned work')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('Period')}</Label>
            <Tabs value={scale} onValueChange={(value) => chooseScale(value as CapacityScale)}>
              <TabsList aria-label={t('Period')} data-testid="capacity-scale">
                <TabsTrigger value="day">{t('Day')}</TabsTrigger>
                <TabsTrigger value="week">{t('Week')}</TabsTrigger>
                <TabsTrigger value="month">{t('Month')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capacity-count">{scale === 'day' ? t('Days') : scale === 'week' ? t('Weeks') : t('Months')}</Label>
            <Select value={String(count)} onValueChange={(value) => setCount(Number(value))}>
              <SelectTrigger id="capacity-count" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LENGTHS[scale].options.map((length) => (
                  <SelectItem key={length} value={String(length)}>
                    {length}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('Dates')}</Label>
            <div className="flex h-9 items-center gap-1">
              <Button variant="secondary" size="icon-sm" aria-label={t('Previous period')} onClick={() => setOffset((value) => value - 1)}>
                <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
              </Button>
              <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(0)}>
                {currentName(scale)}
              </Button>
              <Button variant="secondary" size="icon-sm" aria-label={t('Next period')} onClick={() => setOffset((value) => value + 1)}>
                <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Button>
              {periods.length > 0 ? (
                <span className="ms-1.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground" data-testid="capacity-span">
                  {spanOf(shown, periods[0]!, periods.at(-1)!)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capacity-group">{t('Group by')}</Label>
            <Select value={group} onValueChange={(value) => setGroup(value as CapacityGrouping)}>
              <SelectTrigger id="capacity-group" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">{t('Team')}</SelectItem>
                <SelectItem value="role">{t('Role')}</SelectItem>
                <SelectItem value="department">{t('Department')}</SelectItem>
                <SelectItem value="none">{t('Everyone, one list')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-52 space-y-1.5">
            <Label>{t('Team')}</Label>
            <ComboSelect
              label={t('Team')}
              clearable
              placeholder={t('Every team')}
              value={teamId}
              onChange={setTeamId}
              options={(teams.data ?? []).map((team) => ({ id: team.id, name: team.name }))}
            />
          </div>
          <div className="w-52 space-y-1.5">
            <Label>{t('Role')}</Label>
            <ComboSelect
              label={t('Role')}
              clearable
              placeholder={t('Every role')}
              value={roleId}
              onChange={setRoleId}
              options={(roles.data ?? []).map((role) => ({ id: role.id, name: role.name }))}
            />
          </div>
          <div className="w-52 space-y-1.5">
            <Label>{t('Department')}</Label>
            <ComboSelect
              label={t('Department')}
              clearable
              placeholder={t('Every department')}
              value={departmentId}
              onChange={setDepartmentId}
              options={(departments.data ?? []).map((department) => ({ id: department.id, name: department.name }))}
            />
          </div>
          {measure === 'assigned' ? (
            <label className="flex items-center gap-2 pb-2 text-xs text-foreground">
              <Switch checked={placeholders} onCheckedChange={setPlaceholders} aria-label={t('Include placeholders')} />
              {t('Include placeholders')}
            </label>
          ) : null}
        </CardContent>
      </Card>

      <QueryBoundary
        isLoading={grid.isLoading}
        isError={grid.isError}
        error={grid.error}
        onRetry={() => void grid.refetch()}
        errorTitle={t('The capacity figures could not be loaded')}
        skeleton={<TableSkeleton rows={8} />}
      >
        {data ? (
          data.groups.length === 0 ? (
            <EmptyState icon={Info} title={t('Nobody here')} description={t('No one matches these filters.')} />
          ) : (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{logged ? t('Time logged against the hours available') : t('Load against the hours available')}</CardTitle>
                <CardDescription>
                  {logged
                    ? t(
                        'Each cell is the time logged in a {scale, select, day {day} week {week} other {month}} as a share of the hours available in it; the current one is set against the hours available so far. Work assigned but not logged does not count: choose “Logged time and assigned work” to add it. Open a cell to see the time behind it.',
                        { scale: shown },
                      )
                    : t(
                        'Each cell is the work and bookings falling in a {scale, select, day {day} week {week} other {month}} as a share of the hours available in it. The current one adds the hours already logged to the work still to come; those gone show the hours logged. Open a cell to see what makes it up.',
                        { scale: shown },
                      )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2" data-testid="capacity-legend">
                  {BANDS.map((band) => (
                    <span key={band} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <span className={cn('h-3 w-5 rounded-sm border border-border', BAND_CELL[band])} aria-hidden />
                      {BAND_LABEL[band]} <span className="tabular-nums">({bandRange(band, data.thresholds)})</span>
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full border-collapse text-xs" data-testid="capacity-heatmap" data-scale={shown} data-measure={logged ? 'logged' : 'assigned'}>
                    <thead>
                      <tr className="border-b border-border bg-surface">
                        <th className={cn(stickyCell, 'min-w-52 px-3 py-2 text-start font-medium text-muted-foreground')}>
                          {t('Who')}
                        </th>
                        {periods.map((period) => (
                          <PeriodHeading key={period.start} period={period} scale={shown} today={data.today} />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((entry) => {
                        const open = !collapsed.has(entry.key);
                        return (
                          <Fragment key={entry.key}>
                            <tr className="border-b border-border bg-muted/40">
                              <th scope="row" className={cn(stickyCell, 'bg-muted px-3 py-1.5 text-start font-semibold text-foreground')}>
                                <button
                                  type="button"
                                  className="flex items-center gap-1.5"
                                  onClick={() => toggle(entry.key)}
                                  aria-expanded={open}
                                >
                                  {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />}
                                  <span dir="auto">{entry.name}</span>
                                  <span className="font-normal text-muted-foreground">({entry.rows.length})</span>
                                </button>
                              </th>
                              {entry.cells.map((value) => (
                                <HeatCell
                                  key={value.week}
                                  cell={value}
                                  logged={logged}
                                  narrow={shown === 'day'}
                                  group
                                  onOpen={() => setCell({ key: `group:${group}:${entry.key}`, week: value.week })}
                                />
                              ))}
                            </tr>
                            {open
                              ? entry.rows.map((row) => (
                                  <tr key={row.key} className="border-b border-border last:border-0">
                                    <th scope="row" className={cn(stickyCell, 'px-3 py-1.5 ps-8 text-start font-normal text-foreground')}>
                                      <span className="flex items-center gap-1.5">
                                        <span className="truncate" dir="auto">
                                          {row.name}
                                        </span>
                                        {row.kind === 'placeholder' ? (
                                          <Badge tone="neutral" size="sm">
                                            {t('Placeholder')}
                                          </Badge>
                                        ) : row.kind === 'role' ? (
                                          <Badge tone="warning" size="sm">
                                            {t('Nobody named')}
                                          </Badge>
                                        ) : null}
                                      </span>
                                    </th>
                                    {row.cells.map((value) => (
                                      <HeatCell
                                        key={value.week}
                                        cell={value}
                                        logged={logged}
                                        narrow={shown === 'day'}
                                        onOpen={() => setCell({ key: row.key, week: value.week })}
                                      />
                                    ))}
                                  </tr>
                                ))
                              : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-2xs text-muted-foreground">
                  {!logged && data.undated.items > 0
                    ? t('{count, plural, one {# work package} other {# work packages}} assigned with {hours} still to do but no dates fall in no week.', {
                        count: data.undated.items,
                        hours: hours(data.undated.hours),
                      })
                    : ''}{' '}
                  {data.asOf ? t('Work and time as read {when}.', { when: formatRelative(data.asOf) }) : ''}
                </p>
              </CardContent>
            </Card>
          )
        ) : null}
      </QueryBoundary>

      <CellDetailSheet
        target={cell}
        query={query}
        thresholds={data?.thresholds}
        onOpenChange={(open) => {
          if (!open) setCell(null);
        }}
      />
    </div>
  );
}

/** A column's heading: the weekday and date of a day, the Monday of a week, a month. */
function PeriodHeading({ period, scale, today }: { period: CapacityPeriod; scale: CapacityScale; today: string }) {
  const current = period.start <= today && today <= period.end;
  return (
    <th
      scope="col"
      data-current={current ? 'true' : undefined}
      className={cn(
        'px-1 py-1.5 text-center font-medium tabular-nums text-muted-foreground',
        scale === 'day' ? 'min-w-12' : 'min-w-16',
        period.working === false && 'bg-muted/50 font-normal',
        current && 'text-foreground',
      )}
    >
      {scale === 'day' ? (
        <span className="flex flex-col items-center leading-tight">
          <span className="text-2xs font-normal">{weekdayOf(period.start)}</span>
          <span className="whitespace-nowrap">{formatShortDate(period.start)}</span>
        </span>
      ) : scale === 'month' ? (
        <span className="whitespace-nowrap">{monthOf(period.start)}</span>
      ) : (
        formatShortDate(period.start)
      )}
      {current ? <span className="mx-auto mt-1 block h-0.5 w-6 rounded-full bg-primary" aria-hidden /> : null}
    </th>
  );
}

/** What a cell's figure is made of, as its tooltip says. */
function cellTitle(cell: CapacityCell, logged: boolean): string {
  const load = cell.committed + cell.planned;
  if (logged) {
    if (cell.basis === 'current') {
      return t('So far: {logged} logged of {soFar} available to date, {available} in all', {
        logged: hours(cell.logged),
        soFar: hours(cell.availableSoFar ?? cell.available),
        available: hours(cell.available),
      });
    }
    if (cell.basis === 'forecast' && cell.logged === 0) return t('Still to come: {available} available', { available: hours(cell.available) });
    return t('{logged} logged of {available} available', { logged: hours(cell.logged), available: hours(cell.available) });
  }
  if (cell.basis === 'actual') return t('{logged} logged of {available} available', { logged: hours(cell.logged), available: hours(cell.available) });
  if (cell.basis === 'current') {
    return t('So far: {logged} logged and {load} still to do, of {available} available', {
      logged: hours(cell.logged),
      load: hours(load),
      available: hours(cell.available),
    });
  }
  return t('{load} asked of {available} available: {committed} of work, {planned} booked', {
    load: hours(load),
    available: hours(cell.available),
    committed: hours(cell.committed),
    planned: hours(cell.planned),
  });
}

function HeatCell({
  cell,
  logged,
  narrow,
  group = false,
  onOpen,
}: {
  cell: CapacityCell;
  logged: boolean;
  narrow: boolean;
  group?: boolean;
  onOpen: () => void;
}) {
  const load = cell.committed + cell.planned;
  // The hours the figure stands for: logged alone, or with the work still to come.
  const used = logged || cell.basis === 'actual' ? cell.logged : cell.basis === 'current' ? cell.logged + load : load;
  const gap = used - cell.available;
  // No hours available but some used (time logged on a day off): the hours, not a percentage.
  const figure = cell.ratio !== null ? percent(cell.ratio) : used > 0 ? hours(used) : '—';
  return (
    <td className="p-0.5">
      <button
        type="button"
        onClick={onOpen}
        title={`${BAND_LABEL[cell.band]} · ${cellTitle(cell, logged)}`}
        data-band={cell.band}
        data-over={cell.over ? 'true' : undefined}
        className={cn(
          'flex h-9 w-full flex-col items-center justify-center rounded-sm tabular-nums transition hover:ring-2 hover:ring-primary/40',
          narrow ? 'min-w-11' : 'min-w-14',
          BAND_CELL[cell.band],
          !logged && cell.basis === 'actual' && 'opacity-80',
          cell.over && cell.band !== 'over' && 'ring-2 ring-danger',
        )}
      >
        <span className={cn('leading-none', group && 'font-semibold')}>{figure}</span>
        {group && logged && cell.ratio !== null && cell.logged > 0 ? (
          <span className="mt-0.5 text-[10px] leading-none opacity-80">{hours(cell.logged)}</span>
        ) : null}
        {group && !logged && cell.basis !== 'actual' && used > 0 ? (
          <span className="mt-0.5 text-[10px] leading-none opacity-80">{gap > 0 ? `+${hours(gap)}` : `−${hours(-gap)}`}</span>
        ) : null}
      </button>
    </td>
  );
}
