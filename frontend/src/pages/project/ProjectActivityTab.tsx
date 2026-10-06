import { useParams } from 'react-router-dom';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProjectJournal } from '@/components/projects/ProjectJournal';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';

/**
 * Full change history for a project: the work itself, and the project journal
 * of what EPM owns about it — health, overrides, plan and budget — with who
 * made each change and why.
 */
export default function ProjectActivityTab() {
  const { projectId } = useParams();
  const activityQuery = useActivity({ projectId, limit: 100 });
  const users = useUserMap();
  const paged = usePagination(activityQuery.data ?? [], { pageSize: 15, resetKey: projectId });

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <Card className="lg:col-span-3">
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

      {/* Append-only: nothing in it can be edited or removed, by the API or by
          the database, so it reads as evidence rather than as a feed. */}
      <Card className="lg:col-span-2">
        <CardHeader variant="compact">
          <CardTitle>Project journal</CardTitle>
          <CardDescription>Health, overrides, plan and ownership, as recorded.</CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          {projectId ? <ProjectJournal projectId={projectId} limit={100} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
