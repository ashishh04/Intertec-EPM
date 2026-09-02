import { Link } from 'react-router-dom';
import { ArrowRight, Flag } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { VelocityChart } from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useSprints } from '@/hooks/useSprints';
import { useProjects } from '@/hooks/useProjects';
import { useDeliveryTrends } from '@/hooks/useReports';
import { usePagination } from '@/hooks/usePagination';
import { formatShortDate, pluralize } from '@/lib/utils';

/** Sprint history and cadence across the delivery portfolio. */
export default function SprintsPage() {
  const sprintsQuery = useSprints();
  const projectsQuery = useProjects();
  const trendsQuery = useDeliveryTrends();
  // Sprints accumulate every fortnight, so the history is paged rather than endless.
  const paged = usePagination(sprintsQuery.data ?? [], { pageSize: 8 });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sprints"
        description="Cadence, commitment and delivery across every sprint."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/agile">
              Open agile workspace
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      />

      {trendsQuery.isLoading ? (
        <ChartCardSkeleton height={240} />
      ) : (
        <ChartCard title="Velocity trend" description="Story points delivered per sprint" height={240}>
          <VelocityChart data={trendsQuery.data ?? []} />
        </ChartCard>
      )}

      <QueryBoundary
        isLoading={sprintsQuery.isLoading}
        isError={sprintsQuery.isError}
        error={sprintsQuery.error}
        onRetry={() => sprintsQuery.refetch()}
        errorTitle="Unable to load sprints"
        skeleton={
          <div className="space-y-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-32 rounded-xl" />
            ))}
          </div>
        }
      >
        <div className="space-y-3">
        <ul className="space-y-3">
          {paged.items.map((sprint) => {
            const progress = Math.round(
              (sprint.completedPoints / Math.max(1, sprint.committedPoints)) * 100,
            );
            const sprintProjects = (projectsQuery.data ?? []).filter((project) =>
              sprint.projectIds.includes(project.id),
            );

            return (
              <li key={sprint.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold tracking-tight">{sprint.name}</h2>
                        <SprintStateBadge state={sprint.state} />
                      </div>
                      <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                        {formatShortDate(sprint.startDate)} — {formatShortDate(sprint.endDate)}
                      </p>
                    </div>

                    <dl className="flex gap-6 text-right">
                      <div>
                        <dt className="epm-eyebrow">Committed</dt>
                        <dd className="font-mono text-sm font-semibold tabular-nums">
                          {sprint.committedPoints}
                        </dd>
                      </div>
                      <div>
                        <dt className="epm-eyebrow">Completed</dt>
                        <dd className="font-mono text-sm font-semibold tabular-nums text-success">
                          {sprint.completedPoints}
                        </dd>
                      </div>
                      <div>
                        <dt className="epm-eyebrow">Delivered</dt>
                        <dd className="font-mono text-sm font-semibold tabular-nums">{progress}%</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="mt-3 flex items-start gap-2.5 rounded-lg bg-muted/70 p-3">
                    <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    <p className="text-2xs leading-relaxed text-muted-foreground">{sprint.goal}</p>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <ProgressBar
                      value={progress}
                      tone={sprint.state === 'completed' ? 'success' : 'primary'}
                      label={`${sprint.name} completion`}
                    />
                    <p className="text-2xs text-muted-foreground">
                      {sprintProjects.length} {pluralize(sprintProjects.length, 'project')}:{' '}
                      {sprintProjects.map((project) => project.identifier).join(', ') || '—'}
                    </p>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
          pageSizeOptions={[8, 16, 32]}
          itemLabel="sprint"
          className="rounded-xl border border-border bg-surface"
        />
        </div>
      </QueryBoundary>
    </div>
  );
}
