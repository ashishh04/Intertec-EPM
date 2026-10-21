import { Link } from 'react-router-dom';
import { CalendarClock, Users } from 'lucide-react';

import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCapacityCell } from '@/hooks/useResources';
import { t } from '@/lib/i18n';
import { cn, formatShortDate } from '@/lib/utils';
import type { CapacityQuery } from '@/services/api/resources';
import type { CapacityBand, ResourceThresholds } from '@/types';
import { BAND_LABEL, BAND_TONE, bandRange, hours, percent } from './bands';

/** The solid fill for a band, used by the load meter and the share bars. */
const BAND_FILL: Record<CapacityBand, string> = {
  none: 'bg-neutral-soft',
  under: 'bg-primary',
  healthy: 'bg-success',
  full: 'bg-warning',
  over: 'bg-danger',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');

/**
 * What is behind one cell of the heatmap (BR-314's drill-through): the work
 * and the bookings that fall in that week, how much of each, and — for weeks
 * gone — the time logged. Opens as a centred pop-up over the heatmap.
 */
export function CellDetailSheet({
  target,
  query,
  thresholds,
  onOpenChange,
}: {
  target: { key: string; week: string } | null;
  query: CapacityQuery;
  thresholds?: ResourceThresholds;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useCapacityCell(target?.key ?? null, target?.week ?? null, query);
  const data = detail.data;
  const isGroup = target?.key.startsWith('group:') ?? false;
  const band = data?.cell.band ?? 'none';
  const asked = data ? data.cell.committed + data.cell.planned : 0;
  // The meter runs to whichever is larger, so an overload shows past the line.
  const scale = data ? Math.max(asked, data.cell.available, 1) : 1;
  const largest = data ? Math.max(...data.contributions.map((part) => part.hours), 1) : 1;
  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0" data-testid="capacity-cell">
        <div className="flex items-center gap-3 border-b border-border bg-surface-sunken/50 px-6 py-4 pe-12">
          <Avatar size="lg">
            <AvatarFallback
              className={cn('font-semibold', band === 'over' ? 'bg-danger-soft text-danger-strong' : 'bg-primary-soft text-primary-dark')}
            >
              {isGroup ? <Users className="h-4 w-4" /> : initials(data?.name ?? '')}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <DialogTitle dir="auto" className="truncate">
              {data?.name ?? t('Loading…')}
            </DialogTitle>
            <DialogDescription className="mt-0.5 flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" />
              {target ? t('Week of {date}', { date: formatShortDate(target.week) }) : ''}
            </DialogDescription>
          </div>
          {data ? (
            <div className="text-end">
              <div className={cn('text-2xl font-semibold leading-none tabular-nums', band === 'over' ? 'text-danger' : 'text-foreground')}>
                {percent(data.cell.ratio)}
              </div>
              <div className="mt-1 text-2xs text-muted-foreground">
                {data.cell.basis === 'actual' ? t('Utilisation') : t('Load')}
              </div>
            </div>
          ) : null}
        </div>

        <div className="epm-scroll max-h-[calc(100dvh-10rem)] overflow-y-auto px-6 py-5">
          <QueryBoundary
            isLoading={detail.isLoading}
            isError={detail.isError}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            errorTitle={t('This week could not be loaded')}
            skeleton={<ListSkeleton rows={5} />}
          >
            {data ? (
              <div className="space-y-5">
                <section className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={BAND_TONE[band]} size="sm">
                      {BAND_LABEL[band]}
                    </Badge>
                    {thresholds ? <span className="text-2xs text-muted-foreground">{bandRange(band, thresholds)}</span> : null}
                  </div>
                  <div className="relative h-3 overflow-hidden rounded-full bg-muted">
                    <div className="absolute inset-y-0 start-0 flex w-full">
                      <div className={cn('h-full', BAND_FILL[band])} style={{ width: `${(data.cell.committed / scale) * 100}%` }} />
                      <div className={cn('h-full opacity-50', BAND_FILL[band])} style={{ width: `${(data.cell.planned / scale) * 100}%` }} />
                    </div>
                    {asked > data.cell.available ? (
                      <div
                        className="absolute inset-y-0 w-0.5 bg-foreground"
                        style={{ insetInlineStart: `${(data.cell.available / scale) * 100}%` }}
                      />
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Figure label={t('Available')} value={hours(data.cell.available)} />
                    <Figure label={t('Work assigned')} value={hours(data.cell.committed)} swatch={BAND_FILL[band]} />
                    <Figure label={t('Booked')} value={hours(data.cell.planned)} swatch={cn(BAND_FILL[band], 'opacity-50')} />
                    <Figure label={t('Logged')} value={hours(data.cell.logged)} />
                  </dl>
                </section>

                {data.cell.over ? (
                  <p className="rounded-lg border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-xs text-danger-strong">
                    {t('Over-allocated: asked for {excess} more than the hours available.', {
                      excess: hours(asked - data.cell.available),
                    })}
                  </p>
                ) : null}

                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">{t('What falls in this week')}</h3>
                  {data.contributions.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                      {t('No work or bookings fall in this week.')}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border" data-testid="capacity-contributions">
                      {data.contributions.map((part) => (
                        <li key={`${part.carrierKey}:${part.itemId}`} className="px-4 py-3 transition-colors hover:bg-muted/40">
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              {part.kind === 'work' ? (
                                <Link
                                  to={`/tasks/${part.workPackageId}`}
                                  className="block truncate text-xs font-medium text-foreground hover:underline"
                                  dir="auto"
                                >
                                  {part.subject}
                                </Link>
                              ) : (
                                <span className="block truncate text-xs font-medium text-foreground">
                                  {t('Booked {hours} a week', { hours: hours(part.hoursPerWeek ?? 0) })}
                                </span>
                              )}
                              <span className="block truncate text-2xs text-muted-foreground" dir="auto">
                                {part.projectName}
                                {part.startDate || part.dueDate
                                  ? ` · ${formatShortDate(part.startDate ?? part.dueDate)} – ${formatShortDate(part.dueDate ?? part.startDate)}`
                                  : ''}
                                {isGroup ? ` · ${part.carrierName}` : ''}
                              </span>
                            </div>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{hours(part.hours)}</span>
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn('h-full rounded-full bg-primary', part.kind !== 'work' && 'opacity-50')}
                              style={{ width: `${(part.hours / largest) * 100}%` }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {data.logged.length > 0 ? (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground">{t('Time logged in this week')}</h3>
                    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-xs">
                      {data.logged.map((line) => (
                        <li key={`${line.projectId}:${line.workPackageId}`} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                          <span className="min-w-0 truncate" dir="auto">
                            {line.workPackageId ? (
                              <Link to={`/tasks/${line.workPackageId}`} className="hover:underline">
                                {line.subject ?? `#${line.workPackageId}`}
                              </Link>
                            ) : (
                              t('Not on a work package')
                            )}
                            <span className="ms-1.5 text-muted-foreground">{line.projectName}</span>
                          </span>
                          <span className="font-semibold tabular-nums">{hours(line.hours)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}
          </QueryBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Figure({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {swatch ? <span className={cn('h-2 w-2 rounded-full', swatch)} /> : null}
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
