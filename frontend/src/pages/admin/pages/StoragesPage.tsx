import { useMemo } from 'react';
import { HardDrive } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminStorages } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';
import { formatLongDate } from '@/lib/utils';
import { AdminPagination, AdminTable } from './shared-tables';

/** External file storages: the Nextcloud, OneDrive and similar connections projects can link files from. */
export default function StoragesPage() {
  const storages = useAdminStorages();
  const rows = useMemo(
    () => [...(storages.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [storages.data],
  );
  const paging = usePagination(rows, { pageSize: 25 });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={rows.length} label={t('external storage')} plural={t('external storages')} />
      </ListToolbar>

      <QueryBoundary
        isLoading={storages.isLoading}
        isError={storages.isError}
        error={storages.error}
        onRetry={() => void storages.refetch()}
        errorTitle={t('Storages could not be loaded')}
        skeleton={<TableSkeleton columns={4} rows={3} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={HardDrive}
            title={t('No external file storages are connected')}
            description={t(
              'Storages are connected by the platform team in the delivery system and listed here once they exist.',
            )}
          />
        }
      >
        <AdminTable
          footer={
            <AdminPagination
              paging={paging}
              itemLabel={t('external storage')}
              itemLabelPlural={t('external storages')}
            />
          }
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead>{t('Host')}</TableHead>
              <TableHead>{t('Created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium" dir="auto">{row.name}</TableCell>
                <TableCell>
                  <Badge tone="neutral" size="sm">
                    {row.type}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs">
                  <p className="truncate font-mono text-2xs text-muted-foreground" title={row.host}>
                    {row.host}
                  </p>
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  <time dateTime={row.createdAt}>{formatLongDate(row.createdAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>
    </div>
  );
}
