import { Link } from 'react-router-dom';
import { Coins } from 'lucide-react';

import { formatMeasure } from '@/components/insights/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useEvmSettings, useWorkPackageEarnedValue } from '@/hooks/useEarnedValue';
import { formatRelative } from '@/lib/utils';
import type { ID } from '@/types';

/**
 * This work package's earned value today (BR-301): its budget, what was
 * planned and earned by now and what it cost, and the indices — measured
 * against its project's baseline, or the plan where there is none. Read-only:
 * it moves with the work's progress, dates and time logged.
 */
export function TaskEarnedValue({ workPackageId }: { workPackageId: ID }) {
  const figures = useWorkPackageEarnedValue(workPackageId);
  const settings = useEvmSettings();

  if (figures.isError) return null;
  const data = figures.data;
  const item = data?.item;
  const methodLabel = settings.data?.methods.find((method) => method.id === (item?.method ?? data?.method))?.label;
  const against = data?.measuredAgainst;

  return (
    <Card data-testid="task-earned-value">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-muted-foreground" aria-hidden />
          Earned value
        </CardTitle>
        {methodLabel ? <Badge tone="neutral">Earns by {methodLabel}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {figures.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !item || item.bac === null || (item.bac === 0 && item.ac === 0) ? (
          <p className="text-xs text-muted-foreground">
            {data?.note ??
              (item?.bac === 0 ? 'It has no estimate, so it carries no budget to plan or earn.' : 'Not measured.')}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            <Figure label="Budget (BAC)" value={formatMeasure(item.bac, 'money')} />
            <Figure label="Planned (PV)" value={formatMeasure(item.pv, 'money')} />
            <Figure label="Earned (EV)" value={formatMeasure(item.ev, 'money')} />
            <Figure label="Actual cost (AC)" value={formatMeasure(item.ac, 'money')} />
            <Figure label="Schedule (SPI)" value={formatMeasure(item.spi, 'index')} tone={tone(item.spi)} />
            <Figure label="Cost (CPI)" value={formatMeasure(item.cpi, 'index')} tone={tone(item.cpi)} />
            <Figure label="Schedule variance" value={formatMeasure(item.sv, 'money')} />
            <Figure label="Cost variance" value={formatMeasure(item.cv, 'money')} />
          </dl>
        )}
        {data ? (
          <p className="text-2xs text-muted-foreground">
            {against?.kind === 'baseline'
              ? `Against baseline ${against.number}, set ${formatRelative(against.setAt)}.`
              : against
                ? 'Against the current plan: the project has no baseline.'
                : ''}{' '}
            {data.asOf ? `Data read ${formatRelative(data.asOf)}. ` : ''}
            <Link
              to={`/insights/earned-value?scope=project:${data.projectId}`}
              className="text-foreground underline-offset-2 hover:underline"
            >
              The project’s earned value
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Below 1 is behind or over; at or above, on track. */
const tone = (index: number | null): 'danger' | 'success' | undefined =>
  index === null ? undefined : index < 1 ? 'danger' : 'success';

function Figure({ label, value, tone: shade }: { label: string; value: string; tone?: 'danger' | 'success' }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className={shade === 'danger' ? 'font-medium text-danger' : shade === 'success' ? 'font-medium text-success' : 'font-medium text-foreground'}>
        {value}
      </dd>
    </div>
  );
}
