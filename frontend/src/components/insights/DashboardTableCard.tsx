import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink, Info } from 'lucide-react';

import { TableCard } from '@/components/common/DataTable';
import { Pagination } from '@/components/common/Pagination';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InfoTooltip } from '@/components/ui/tooltip';
import { usePagination } from '@/hooks/usePagination';
import { cn, formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { DashboardRow, DashboardTable, HealthLevel, MeasureScopeKind } from '@/types';
import { formatMeasure } from './format';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A dashboard's table, rendered from its description: columns of measures
 * (formatted by unit, defined in the header's tooltip) and rows that lead
 * somewhere. A portfolio, department, team, project or person opens this
 * dashboard scoped to it; a work package opens itself — the drill-through
 * from portfolio to project to work package (BR-405).
 */
export function DashboardTableCard({
  table,
  definitions,
  onScope,
  resetKey,
}: {
  table: DashboardTable;
  definitions: Map<string, string>;
  onScope: (kind: MeasureScopeKind, id: string) => void;
  resetKey: string;
}) {
  const navigate = useNavigate();
  const paged = usePagination(table.rows, { pageSize: 10, resetKey });

  const open = (row: DashboardRow) => {
    if (!row.link) return;
    if (row.link.kind === 'work_package') navigate(`/tasks/${row.link.id}`);
    else onScope(row.link.kind, row.link.id);
  };

  return (
    <TableCard
      toolbar={
        <CardHeader variant="compact" className="border-0">
          <CardTitle>{table.title}</CardTitle>
          {table.description ? <CardDescription className="text-2xs">{table.description}</CardDescription> : null}
        </CardHeader>
      }
      footer={
        table.rows.length > 10 ? (
          <Pagination
            page={paged.page}
            pageSize={paged.pageSize}
            total={paged.total}
            onPageChange={paged.setPage}
            onPageSizeChange={paged.setPageSize}
            itemLabel={t('row')}
            itemLabelPlural={t('rows')}
          />
        ) : undefined
      }
    >
      {table.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('Nothing in this scope and period.')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {table.columns.map((column, index) => (
                <TableHead key={column.key} numeric={Boolean(column.unit) && index > 0}>
                  <span className="inline-flex items-center gap-1">
                    {column.label}
                    {column.measureId && definitions.get(column.measureId) ? (
                      <InfoTooltip label={definitions.get(column.measureId)!}>
                        <span tabIndex={0} aria-label={t('How {label} is defined', { label: column.label })}>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </span>
                      </InfoTooltip>
                    ) : null}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.items.map((row) => (
              <TableRow
                key={row.key}
                className={cn(row.link && 'cursor-pointer')}
                onClick={() => open(row)}
                tabIndex={row.link ? 0 : undefined}
                onKeyDown={(event) => {
                  if (row.link && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    open(row);
                  }
                }}
              >
                {table.columns.map((column, index) => {
                  const value = row.cells[column.key] ?? null;
                  if (index === 0) {
                    return (
                      <TableCell key={column.key} className="max-w-72">
                        <span className="flex items-center gap-1.5">
                          <span className="line-clamp-2 font-medium text-foreground" dir="auto">{String(value ?? '')}</span>
                          {row.link?.kind === 'project' ? (
                            <Link
                              to={`/projects/${row.link.id}`}
                              onClick={(event) => event.stopPropagation()}
                              aria-label={t('Open the project {name}', { name: String(value ?? '') })}
                              className="text-muted-foreground hover:text-primary"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          ) : null}
                        </span>
                      </TableCell>
                    );
                  }
                  if (column.key === 'health') {
                    return (
                      <TableCell key={column.key}>
                        <HealthIndicator level={(value as HealthLevel | null) ?? null} />
                      </TableCell>
                    );
                  }
                  if (column.unit) {
                    return (
                      <TableCell key={column.key} numeric>
                        {formatMeasure(typeof value === 'number' ? value : null, column.unit)}
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell key={column.key} className="text-xs text-muted-foreground">
                      {typeof value === 'string' && DAY.test(value) ? formatShortDate(value) : (value ?? '—')}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}
