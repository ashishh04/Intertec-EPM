import { useParams } from 'react-router-dom';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProjectJournalPaged } from '@/components/projects/ProjectJournal';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';

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
    // Two lists side by side, the same width and the same height: each card
    // stretches to the taller of the two and keeps its pager on its bottom
    // edge, so the cards and their pagers line up.
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="flex flex-col">
        <CardHeader variant="compact">
          <CardTitle>{t('Activity')}</CardTitle>
        </CardHeader>
        {/* The timeline draws its own empty state, so the boundary only has to
            cover loading and failure. */}
        <CardContent className="flex-1 p-4">
          <QueryBoundary
            isLoading={activityQuery.isLoading}
            isError={activityQuery.isError}
            error={activityQuery.error}
            onRetry={() => activityQuery.refetch()}
            errorTitle={t('Unable to load activity')}
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
          itemLabel={t('event')}
          itemLabelPlural={t('events')}
          className="border-t border-border"
        />
      </Card>

      {/* Append-only: nothing in it can be edited or removed, by the API or by
          the database, so it reads as evidence rather than as a feed. */}
      <Card className="flex flex-col">
        <CardHeader variant="compact">
          <CardTitle>{t('Project journal')}</CardTitle>
          <CardDescription>{t('Health, overrides, plan and ownership, as recorded.')}</CardDescription>
        </CardHeader>
        {projectId ? <ProjectJournalPaged projectId={projectId} /> : null}
      </Card>
    </div>
  );
}
