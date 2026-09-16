import { useParams } from 'react-router-dom';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';

/** Full change history for a project. */
export default function ProjectActivityTab() {
  const { projectId } = useParams();
  const activityQuery = useActivity({ projectId, limit: 100 });
  const users = useUserMap();
  const paged = usePagination(activityQuery.data ?? [], { pageSize: 15, resetKey: projectId });

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      {/* The timeline draws its own empty state, so the boundary only has to
          cover loading and failure. */}
      <CardContent className="p-4">
        <QueryBoundary
          isLoading={activityQuery.isLoading}
          isError={activityQuery.isError}
          error={activityQuery.error}
          onRetry={() => activityQuery.refetch()}
          errorTitle="Unable to load activity"
          skeleton={<ActivityTimelineSkeleton rows={8} />}
        >
          <ActivityTimeline entries={paged.items} users={users} />
        </QueryBoundary>
      </CardContent>
      <Pagination
        page={paged.page}
        pageSize={paged.pageSize}
        total={paged.total}
        onPageChange={paged.setPage}
        onPageSizeChange={paged.setPageSize}
        pageSizeOptions={[10, 15, 25, 50]}
        itemLabel="event"
        className="border-t border-border"
      />
    </Card>
  );
}
