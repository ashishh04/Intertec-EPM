import { useMemo } from 'react';
import { FlaskConical } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { AdminPagination, AdminTable } from './shared-tables';

/** Experimental features: the feature flags switched on for this instance. */
export default function ExperimentalPage() {
  const configuration = useAdminConfiguration();
  const flags = useMemo(
    () => [...(configuration.data?.activeFeatureFlags ?? [])].sort((a, b) => a.localeCompare(b)),
    [configuration.data],
  );
  const paging = usePagination(flags, { pageSize: 25 });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={flags.length} label="experimental feature" />
      </ListToolbar>

      <QueryBoundary
        isLoading={configuration.isLoading}
        isError={configuration.isError}
        error={configuration.error}
        onRetry={() => void configuration.refetch()}
        errorTitle="Configuration could not be loaded"
        skeleton={<TableSkeleton columns={2} rows={3} />}
        isEmpty={flags.length === 0}
        empty={
          <EmptyState
            icon={FlaskConical}
            title="No experimental features are enabled"
            description="Feature flags are switched on by the platform team in the delivery system."
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="experimental feature" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Flag name</TableHead>
              <TableHead className="w-28">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((flag) => (
              <TableRow key={flag}>
                <TableCell className="font-mono text-2xs">{flag}</TableCell>
                <TableCell>
                  <Badge tone="success" size="sm" dot>
                    Active
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>
    </div>
  );
}
