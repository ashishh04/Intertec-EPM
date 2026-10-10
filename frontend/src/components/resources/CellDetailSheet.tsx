import { Link } from 'react-router-dom';

import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCapacityCell } from '@/hooks/useResources';
import { isRightToLeft, t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { CapacityQuery } from '@/services/api/resources';
import type { ResourceThresholds } from '@/types';
import { BAND_LABEL, BAND_TONE, bandRange, hours, percent } from './bands';

/**
 * What is behind one cell of the heatmap (BR-314's drill-through): the work
 * and the bookings that fall in that week, how much of each, and — for weeks
 * gone — the time logged.
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
  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent side={isRightToLeft() ? 'left' : 'right'} className="w-full overflow-y-auto sm:max-w-xl" data-testid="capacity-cell">
        <SheetHeader>
          <SheetTitle dir="auto">{data?.name ?? t('Loading…')}</SheetTitle>
          <SheetDescription>{target ? t('Week of {date}', { date: formatShortDate(target.week) }) : ''}</SheetDescription>
        </SheetHeader>
        <QueryBoundary
          isLoading={detail.isLoading}
          isError={detail.isError}
          error={detail.error}
          onRetry={() => void detail.refetch()}
          errorTitle={t('This week could not be loaded')}
          skeleton={<ListSkeleton rows={5} />}
        >
          {data ? (
            <div className="mt-4 space-y-5">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
                <Figure label={t('Available')} value={hours(data.cell.available)} />
                <Figure label={t('Work assigned')} value={hours(data.cell.committed)} />
                <Figure label={t('Booked')} value={hours(data.cell.planned)} />
                <Figure label={t('Logged')} value={hours(data.cell.logged)} />
                <Figure label={data.cell.basis === 'actual' ? t('Utilisation') : t('Load')} value={percent(data.cell.ratio)} />
                <div>
                  <dt className="text-2xs text-muted-foreground">{t('Band')}</dt>
                  <dd>
                    <Badge tone={BAND_TONE[data.cell.band]} size="sm">
                      {BAND_LABEL[data.cell.band]}
                    </Badge>
                    {thresholds ? <span className="ms-1.5 text-2xs text-muted-foreground">{bandRange(data.cell.band, thresholds)}</span> : null}
                  </dd>
                </div>
              </dl>
              {data.cell.over ? (
                <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger-strong">
                  {t('Over-allocated: asked for {excess} more than the hours available.', {
                    excess: hours(data.cell.committed + data.cell.planned - data.cell.available),
                  })}
                </p>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold text-foreground">{t('What falls in this week')}</h3>
                {data.contributions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('No work or bookings fall in this week.')}</p>
                ) : (
                  <Table data-testid="capacity-contributions">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('Work or booking')}</TableHead>
                        <TableHead>{t('Who')}</TableHead>
                        <TableHead numeric>{t('Hours')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.contributions.map((part) => (
                        <TableRow key={`${part.carrierKey}:${part.itemId}`}>
                          <TableCell>
                            {part.kind === 'work' ? (
                              <Link to={`/tasks/${part.workPackageId}`} className="font-medium text-foreground hover:underline" dir="auto">
                                {part.subject}
                              </Link>
                            ) : (
                              <span className="font-medium text-foreground">
                                {t('Booked {hours} a week', { hours: hours(part.hoursPerWeek ?? 0) })}
                              </span>
                            )}
                            <span className="block text-2xs text-muted-foreground" dir="auto">
                              {part.projectName}
                              {part.startDate || part.dueDate
                                ? ` · ${formatShortDate(part.startDate ?? part.dueDate)} – ${formatShortDate(part.dueDate ?? part.startDate)}`
                                : ''}
                            </span>
                          </TableCell>
                          <TableCell dir="auto">{part.carrierName}</TableCell>
                          <TableCell numeric>{hours(part.hours)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>

              {data.logged.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">{t('Time logged in this week')}</h3>
                  <ul className="divide-y divide-border text-xs">
                    {data.logged.map((line) => (
                      <li key={`${line.projectId}:${line.workPackageId}`} className="flex items-baseline justify-between gap-3 py-1.5">
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
                        <span className="tabular-nums">{hours(line.hours)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
        </QueryBoundary>
      </SheetContent>
    </Sheet>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
