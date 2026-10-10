import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ListChecks, Repeat } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SeriesStateBadge } from '@/components/tasks/TaskSeries';
import { useProjectSeries } from '@/hooks/useTaskSeries';
import { t } from '@/lib/i18n';
import { cn, formatLongDate, formatNumber } from '@/lib/utils';
import type { ID } from '@/types';

/**
 * A project's recurring work (BR-107: the series viewed as a set): every
 * series in the project, active first — its template, its rule in words, its
 * state, its next date and how many tasks it has made.
 */
export function RecurringWorkList({ projectId }: { projectId: ID | undefined }) {
  const list = useProjectSeries(projectId);
  const series = list.data ?? [];

  return (
    <Card data-testid="recurring-work">
      <CardHeader className="space-y-1 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Recurring work')}
        </CardTitle>
        <p className="text-2xs text-muted-foreground">
          {t('Tasks this project repeats on a schedule. Each occurrence’s task is made from its template, ahead of its date.')}
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary
          isLoading={list.isLoading}
          isError={list.isError}
          error={list.error}
          onRetry={() => list.refetch()}
          errorTitle={t('Unable to load recurring work')}
          skeleton={<Skeleton className="h-24 w-full" />}
          isEmpty={series.length === 0}
          empty={
            <EmptyState
              size="inline"
              icon={Repeat}
              title={t('No recurring work yet')}
              description={t('Open a task and choose “Make recurring” in its menu to repeat it on a schedule.')}
            />
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Template')}</TableHead>
                <TableHead>{t('Repeats')}</TableHead>
                <TableHead>{t('State')}</TableHead>
                <TableHead>{t('Next')}</TableHead>
                <TableHead className="text-end">{t('Tasks made')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((one) => (
                <TableRow key={one.id}>
                  <TableCell className="max-w-64">
                    <Link to={`/tasks/${one.templateWorkPackageId}`} dir="auto" className="block truncate text-xs font-medium text-primary hover:underline">
                      {one.templateSubject ?? `#${one.templateWorkPackageId}`}
                    </Link>
                  </TableCell>
                  <TableCell className="text-2xs text-muted-foreground">
                    <span dir="auto">{one.ruleText}</span>
                    {one.problem ? (
                      <span className="mt-0.5 flex items-start gap-1 text-warning-strong">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                        {one.problem}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <SeriesStateBadge series={one} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs">
                    {one.state === 'cancelled' ? '—' : one.nextOccurrence ? formatLongDate(one.nextOccurrence) : t('None: finished')}
                  </TableCell>
                  <TableCell className="text-end font-mono text-2xs tabular-nums">{formatNumber(one.instanceCount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

/**
 * The project's Tasks tab shows its work packages or its recurring work; which
 * is in the address (`?view=recurring`), so either can be linked to.
 */
export function useTasksView(): ['all' | 'recurring', (view: 'all' | 'recurring') => void] {
  const [search, setSearch] = useSearchParams();
  const view = search.get('view') === 'recurring' ? 'recurring' : 'all';
  const choose = (next: 'all' | 'recurring') => {
    const params = new URLSearchParams(search);
    if (next === 'recurring') params.set('view', 'recurring');
    else params.delete('view');
    setSearch(params, { replace: true });
  };
  return [view, choose];
}

export function TasksViewSwitch({ view, onChange }: { view: 'all' | 'recurring'; onChange: (view: 'all' | 'recurring') => void }) {
  const options = [
    { id: 'all' as const, label: t('Work packages'), icon: ListChecks },
    { id: 'recurring' as const, label: t('Recurring work'), icon: Repeat },
  ];
  return (
    <div className="inline-flex rounded-full border border-border bg-surface p-0.5" role="group" aria-label={t('What the tab shows')}>
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => onChange(id)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            view === id ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
