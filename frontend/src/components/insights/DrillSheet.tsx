import { Link } from 'react-router-dom';
import { ArrowUpRight, Inbox } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMeasureMembers } from '@/hooks/useInsights';
import { usePagination } from '@/hooks/usePagination';
import { formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { InsightQuery } from '@/services/api/insights';
import type { MeasureMembers, MeasureScopeKind } from '@/types';
import { formatMeasure } from './format';

/**
 * The drill-through (BR-405): the work packages, projects or people behind a
 * figure, from the same definition that counted them — so the list is always
 * as long as the number. A work package opens itself; a project or a person
 * opens on the dashboard, scoped to them, or on its own page.
 */
export function DrillSheet({
  measureId,
  query,
  onClose,
  onScope,
}: {
  measureId: string | undefined;
  query: InsightQuery;
  onClose: () => void;
  /** Re-scopes the dashboard to a project or a person. */
  onScope: (kind: MeasureScopeKind, id: string) => void;
}) {
  const result = useMeasureMembers(measureId, query);
  const measure = result.data?.measure;

  return (
    <Sheet open={Boolean(measureId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border p-5">
          <SheetTitle>
            {measure ? (
              <span className="flex flex-wrap items-baseline gap-2">
                {measure.label}
                <span className="font-display text-lg tabular-nums text-primary">
                  {formatMeasure(measure.value, measure.unit)}
                </span>
              </span>
            ) : (
              <Skeleton className="h-5 w-48" />
            )}
          </SheetTitle>
          <SheetDescription>{measure?.definition ?? ' '}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <QueryBoundary
            isLoading={result.isLoading}
            isError={result.isError}
            error={result.error}
            onRetry={() => result.refetch()}
            errorTitle={t('Unable to load what is behind this figure')}
            skeleton={
              <div className="space-y-2 p-5">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            }
            isEmpty={(result.data?.members.items.length ?? 0) === 0}
            empty={
              <EmptyState
                size="inline"
                icon={Inbox}
                title={t('Nothing behind this figure')}
                description={t('Nothing in this scope and period matches the definition.')}
              />
            }
          >
            {result.data ? <MemberList members={result.data.members} onScope={onScope} onClose={onClose} /> : null}
          </QueryBoundary>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The items behind a figure: work packages, projects or people. Shared with the portfolio drill. */
export function MemberList({
  members,
  onScope,
  onClose,
}: {
  members: MeasureMembers;
  onScope: (kind: MeasureScopeKind, id: string) => void;
  onClose: () => void;
}) {
  const items = members.items as unknown[];
  const paged = usePagination(items, { pageSize: 15, resetKey: members.kind });

  return (
    <>
      <Table>
        {members.kind === 'work_package' ? (
          <>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Work package')}</TableHead>
                <TableHead>{t('Project')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead>{t('Due')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(paged.items as Extract<MeasureMembers, { kind: 'work_package' }>['items']).map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-64">
                    <Link
                      to={`/tasks/${item.id}`}
                      onClick={onClose}
                      className="line-clamp-2 font-medium text-foreground hover:text-primary hover:underline"
                      dir="auto"
                    >
                      {item.subject}
                    </Link>
                    <span className="text-2xs text-muted-foreground">
                      #{item.id}
                      {item.assigneeName ? ` · ${item.assigneeName}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.projectName}</TableCell>
                  <TableCell className="text-xs">{item.status}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {item.dueDate ? formatShortDate(item.dueDate) : '—'}
                    {item.flag ? (
                      <Badge
                        size="sm"
                        tone={item.flag === 'met' ? 'success' : 'danger'}
                        className="ms-1.5"
                      >
                        {item.flag}
                      </Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </>
        ) : members.kind === 'project' ? (
          <>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Project')}</TableHead>
                <TableHead>{t('Health')}</TableHead>
                <TableHead numeric>{t('Schedule')}</TableHead>
                <TableHead numeric>{t('Budget')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(paged.items as Extract<MeasureMembers, { kind: 'project' }>['items']).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      to={`/projects/${item.id}`}
                      onClick={onClose}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <HealthIndicator level={item.health} />
                  </TableCell>
                  <TableCell numeric>{formatMeasure(item.scheduleVarianceDays, 'days')}</TableCell>
                  <TableCell numeric>{formatMeasure(item.budget, 'money')}</TableCell>
                  <TableCell className="text-end">
                    <Button size="sm" variant="ghost" onClick={() => onScope('project', String(item.id))}>
                      {t('Dashboard')}
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </>
        ) : (
          <>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Person')}</TableHead>
                <TableHead numeric>{t('Capacity / wk')}</TableHead>
                <TableHead numeric>{t('Logged')}</TableHead>
                <TableHead numeric>{t('Utilisation')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(paged.items as Extract<MeasureMembers, { kind: 'person' }>['items']).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onScope('person', String(item.id))}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {item.name}
                    </button>
                  </TableCell>
                  <TableCell numeric>{formatMeasure(item.weeklyCapacityHours, 'hours')}</TableCell>
                  <TableCell numeric>{formatMeasure(item.loggedHours, 'hours')}</TableCell>
                  <TableCell numeric>{formatMeasure(item.utilisation, 'percent')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </>
        )}
      </Table>
      {paged.total > 15 ? (
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
          pageSizeOptions={[15, 25, 50]}
          itemLabel={members.kind === 'work_package' ? t('work package') : members.kind === 'project' ? t('project') : t('item')}
          itemLabelPlural={members.kind === 'work_package' ? t('work packages') : members.kind === 'project' ? t('projects') : t('items')}
          className="border-t border-border"
        />
      ) : null}
    </>
  );
}
