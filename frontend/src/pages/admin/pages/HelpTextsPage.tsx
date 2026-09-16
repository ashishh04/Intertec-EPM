import { useMemo } from 'react';
import { HelpCircle } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminHelpTexts } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { AdminPagination, AdminTable } from './shared-tables';

/**
 * Attribute help texts: the explanations shown next to a work package or
 * project attribute. Authored centrally, listed here so an administrator can
 * see what people are being told.
 */
export default function HelpTextsPage() {
  const helpTexts = useAdminHelpTexts();
  const rows = useMemo(() => helpTexts.data ?? [], [helpTexts.data]);
  const paging = usePagination(rows, { pageSize: 25 });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={rows.length} label="help text" />
      </ListToolbar>

      <QueryBoundary
        isLoading={helpTexts.isLoading}
        isError={helpTexts.isError}
        error={helpTexts.error}
        onRetry={() => void helpTexts.refetch()}
        errorTitle="Help texts could not be loaded"
        skeleton={<TableSkeleton columns={3} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={HelpCircle}
            title="No attribute help texts have been written yet"
            description="Help texts are authored centrally in the delivery system and appear here once they exist."
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="help text" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Attribute</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Help text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <p className="font-medium">{row.attributeCaption}</p>
                  <p className="font-mono text-2xs text-muted-foreground">{row.attribute}</p>
                </TableCell>
                <TableCell>
                  <Badge tone="neutral" size="sm" className="capitalize">
                    {row.scope}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-md">
                  <p className="truncate text-muted-foreground" title={row.helpText}>
                    {row.helpText}
                  </p>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>
    </div>
  );
}
