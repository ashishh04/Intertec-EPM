import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useResourceRoles, useCapacity } from '@/hooks/useResources';
import { useTeams } from '@/hooks/useTeams';
import { useDepartments } from '@/hooks/useDepartments';
import { t } from '@/lib/i18n';
import { cn, formatRelative, formatShortDate } from '@/lib/utils';
import type { CapacityQuery } from '@/services/api/resources';
import type { CapacityBand, CapacityCell, CapacityGrouping } from '@/types';
import { BAND_CELL, BAND_LABEL, bandRange, hours, percent } from './bands';
import { CellDetailSheet } from './CellDetailSheet';

const BANDS: CapacityBand[] = ['under', 'healthy', 'full', 'over'];
const stickyCell = 'sticky start-0 z-10 bg-surface';

/** Monday `offset` weeks from this one, as `YYYY-MM-DD`. */
function mondayFrom(offset: number): string {
  const now = new Date();
  const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday + offset * 7);
  return day.toISOString().slice(0, 10);
}

/**
 * The capacity heatmap and forecast (BR-313, BR-314): people — and the
 * placeholders and roles booked with nobody named — by week, each cell the
 * load asked of them as a share of the hours they have, coloured by the
 * instance's thresholds. Weeks gone show what was logged. Every cell opens on
 * the work and bookings behind it.
 */
export function CapacityHeatmap() {
  const [group, setGroup] = useState<CapacityGrouping>('team');
  const [weeks, setWeeks] = useState(12);
  const [offset, setOffset] = useState(0);
  const [teamId, setTeamId] = useState<string>();
  const [roleId, setRoleId] = useState<string>();
  const [departmentId, setDepartmentId] = useState<string>();
  const [placeholders, setPlaceholders] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cell, setCell] = useState<{ key: string; week: string } | null>(null);

  const query: CapacityQuery = useMemo(
    () => ({ from: mondayFrom(offset), weeks, group, teamId, roleId, departmentId, placeholders }),
    [offset, weeks, group, teamId, roleId, departmentId, placeholders],
  );
  const grid = useCapacity(query);
  const teams = useTeams();
  const roles = useResourceRoles();
  const departments = useDepartments();

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const data = grid.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
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
          <div className="space-y-1.5">
            <Label htmlFor="capacity-from">{t('From')}</Label>
            <Select value={String(offset)} onValueChange={(value) => setOffset(Number(value))}>
              <SelectTrigger id="capacity-from" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('This week')}</SelectItem>
                <SelectItem value="-4">{t('4 weeks back')}</SelectItem>
                <SelectItem value="-8">{t('8 weeks back')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capacity-weeks">{t('Weeks')}</Label>
            <Select value={String(weeks)} onValueChange={(value) => setWeeks(Number(value))}>
              <SelectTrigger id="capacity-weeks" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[8, 12, 26].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count}
                  </SelectItem>
                ))}
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
          <label className="flex items-center gap-2 pb-2 text-xs text-foreground">
            <Switch checked={placeholders} onCheckedChange={setPlaceholders} aria-label={t('Include placeholders')} />
            {t('Include placeholders')}
          </label>
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
                <CardTitle>{t('Load against the hours available')}</CardTitle>
                <CardDescription>
                  {t(
                    'Each cell is the work and bookings falling in a week as a share of the hours available that week — from today in this week. Weeks gone show the hours logged instead. Open a cell to see what makes it up.',
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
                  <table className="w-full border-collapse text-xs" data-testid="capacity-heatmap">
                    <thead>
                      <tr className="border-b border-border bg-surface">
                        <th className={cn(stickyCell, 'min-w-52 px-3 py-2 text-start font-medium text-muted-foreground')}>
                          {t('Who')}
                        </th>
                        {data.weeks.map((week) => (
                          <th
                            key={week}
                            className={cn(
                              'min-w-16 px-1 py-2 text-center font-medium tabular-nums text-muted-foreground',
                              week <= data.today && data.today < addDays(week, 7) && 'text-foreground',
                            )}
                          >
                            {formatShortDate(week)}
                          </th>
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
                                  {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                                  <span dir="auto">{entry.name}</span>
                                  <span className="font-normal text-muted-foreground">({entry.rows.length})</span>
                                </button>
                              </th>
                              {entry.cells.map((value) => (
                                <HeatCell
                                  key={value.week}
                                  cell={value}
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
                                      <HeatCell key={value.week} cell={value} onOpen={() => setCell({ key: row.key, week: value.week })} />
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
                  {data.undated.items > 0
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

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function HeatCell({ cell, group = false, onOpen }: { cell: CapacityCell; group?: boolean; onOpen: () => void }) {
  const load = cell.committed + cell.planned;
  const gap = load - cell.available;
  const title =
    cell.basis === 'actual'
      ? t('{logged} logged of {available} available', { logged: hours(cell.logged), available: hours(cell.available) })
      : t('{load} asked of {available} available: {committed} of work, {planned} booked', {
          load: hours(load),
          available: hours(cell.available),
          committed: hours(cell.committed),
          planned: hours(cell.planned),
        });
  return (
    <td className="p-0.5">
      <button
        type="button"
        onClick={onOpen}
        title={`${BAND_LABEL[cell.band]} · ${title}`}
        data-band={cell.band}
        data-over={cell.over ? 'true' : undefined}
        className={cn(
          'flex h-9 w-full min-w-14 flex-col items-center justify-center rounded-sm tabular-nums transition hover:ring-2 hover:ring-primary/40',
          BAND_CELL[cell.band],
          cell.basis === 'actual' && 'opacity-80',
          cell.over && cell.band !== 'over' && 'ring-2 ring-danger',
        )}
      >
        <span className={cn('leading-none', group && 'font-semibold')}>{percent(cell.ratio)}</span>
        {group && cell.basis === 'forecast' && load > 0 ? (
          <span className="mt-0.5 text-[10px] leading-none opacity-80">{gap > 0 ? `+${hours(gap)}` : `−${hours(-gap)}`}</span>
        ) : null}
      </button>
    </td>
  );
}
