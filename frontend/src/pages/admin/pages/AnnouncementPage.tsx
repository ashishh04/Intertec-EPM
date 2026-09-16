import { useMemo } from 'react';
import { Megaphone } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminNews } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { formatLongDate } from '@/lib/utils';
import { AdminPagination, AdminTable } from './shared-tables';

/** Announcements: the news items published across projects, newest first. */
export default function AnnouncementPage() {
  const news = useAdminNews();
  const rows = useMemo(
    () => [...(news.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [news.data],
  );
  const paging = usePagination(rows, { pageSize: 25 });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={rows.length} label="news item" />
      </ListToolbar>

      <QueryBoundary
        isLoading={news.isLoading}
        isError={news.isError}
        error={news.error}
        onRetry={() => void news.refetch()}
        errorTitle="News could not be loaded"
        skeleton={<TableSkeleton columns={4} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={Megaphone}
            title="No announcements have been published"
            description="News is written inside a project in the delivery system and listed here once it exists."
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="news item" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="max-w-md">
                  <p className="truncate font-medium" title={row.title}>
                    {row.title}
                  </p>
                  {row.summary ? (
                    <p className="truncate text-2xs text-muted-foreground" title={row.summary}>
                      {row.summary}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>{row.projectName}</TableCell>
                <TableCell>{row.authorName}</TableCell>
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
