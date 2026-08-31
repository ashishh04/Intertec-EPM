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
  const activityQuery = useActivity({ projectId, limit: 40 });
  const users = useUserMap();
  const paged = usePagination(activityQuery.data ?? [], { pageSize: 15, resetKey: projectId });

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b border-border">
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent className="pt-5">
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
        itemLabel="event"
        className="border-t border-border"
      />
    </Card>
  );
}
