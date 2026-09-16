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
import { formatLongDate } from '@/lib/utils';
import { AdminPagination, AdminTable } from './shared-tables';

const STATUS_TONE: Record<string, Tone> = {
  open: 'success',
  locked: 'warning',
  closed: 'neutral',
};

const SHARING_LABEL: Record<string, string> = {
  none: 'Not shared',
  descendants: 'Subprojects',
  hierarchy: 'Project hierarchy',
  tree: 'Project tree',
  system: 'All projects',
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
        <ResultCount count={rows.length} label="version" />
      </ListToolbar>

      <QueryBoundary
        isLoading={versions.isLoading}
        isError={versions.isError}
        error={versions.error}
        onRetry={() => void versions.refetch()}
        errorTitle="Versions could not be loaded"
        skeleton={<TableSkeleton columns={6} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={Layers}
            title="No versions exist yet"
            description="Versions are created inside a project. Sprints and backlogs appear here once a project has one."
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="version" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>End</TableHead>
              <TableHead>Sharing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => {
              const status = row.status.toLowerCase();
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{row.projectName}</TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[status] ?? 'neutral'} size="sm" dot className="capitalize">
                      {status}
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
