import { useMemo } from 'react';
import { Layers } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminVersions } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import type { Tone } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { formatLongDate } from '@/lib/utils';
import { AdminPagination, AdminTable } from './shared-tables';

const STATUS_TONE: Record<string, Tone> = {
  open: 'success',
  locked: 'warning',
  closed: 'neutral',
};

const SHARING_LABEL: Record<string, string> = {
  get none() { return t('Not shared'); },
  get descendants() { return t('Subprojects'); },
  get hierarchy() { return t('Project hierarchy'); },
  get tree() { return t('Project tree'); },
  get system() { return t('All projects'); },
};

/** Backlogs: every version sprints and product backlogs are planned into. */
export default function BacklogsPage() {
  const versions = useAdminVersions();
  const rows = useMemo(
    () =>
      [...(versions.data ?? [])].sort(
        (a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name),
      ),
    [versions.data],
  );
  const paging = usePagination(rows, { pageSize: 25 });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={rows.length} label={t('version')} plural={t('versions')} />
      </ListToolbar>

      <QueryBoundary
        isLoading={versions.isLoading}
        isError={versions.isError}
        error={versions.error}
        onRetry={() => void versions.refetch()}
        errorTitle={t('Versions could not be loaded')}
        skeleton={<TableSkeleton columns={6} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={Layers}
            title={t('No versions exist yet')}
            description={t('Versions are created inside a project. Sprints and backlogs appear here once a project has one.')}
          />
        }
      >
        <AdminTable
          footer={<AdminPagination paging={paging} itemLabel={t('version')} itemLabelPlural={t('versions')} />}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Project')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Start')}</TableHead>
              <TableHead>{t('End')}</TableHead>
              <TableHead>{t('Sharing')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => {
              const status = row.status.toLowerCase();
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-medium" dir="auto">{row.name}</TableCell>
                  <TableCell dir="auto">{row.projectName}</TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[status] ?? 'neutral'} size="sm" dot className="capitalize">
                      {t('{status, select, open {open} locked {locked} closed {closed} other {{status}}}', { status })}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(row.startDate)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(row.endDate)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {SHARING_LABEL[row.sharing] ?? row.sharing}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </AdminTable>
      </QueryBoundary>
    </div>
  );
}
