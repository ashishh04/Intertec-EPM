import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Flag, Plus, Timer } from 'lucide-react';
import { SprintDialog } from '@/components/sprints/SprintDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { ListSkeleton } from '@/components/common/DataTable';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { VelocityChart } from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { useSprints } from '@/hooks/useSprints';
import { useProjects } from '@/hooks/useProjects';
import { useDeliveryTrends } from '@/hooks/useReports';
import { usePagination } from '@/hooks/usePagination';
import { formatNumber, formatPercent, formatShortDate, pluralize } from '@/lib/utils';

/** Sprint history and cadence across the delivery portfolio. */
export default function SprintsPage() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const sprintsQuery = useSprints();
  const projectsQuery = useProjects();
  const trendsQuery = useDeliveryTrends();
  // Sprints accumulate every fortnight, so the history is paged rather than
  // endless. There is no filter or search on this page, so nothing needs a
  // resetKey — the page only changes when the reader changes it.
  const paged = usePagination(sprintsQuery.data ?? [], { pageSize: 8 });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sprints"
        description="Cadence, commitment and delivery across every sprint."
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/agile">
                Agile workspace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New sprint
            </Button>
          </>
        }
      />

      {/* A sprint made here opens in the workspace, where it can be started. */}
      <SprintDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(sprint) => navigate(`/agile?sprint=${sprint.id}`)}
      />

      <QueryBoundary
        isLoading={trendsQuery.isLoading}
        isError={trendsQuery.isError}
        error={trendsQuery.error}
        onRetry={() => trendsQuery.refetch()}
        errorTitle="Unable to load velocity"
        skeleton={<ChartCardSkeleton height={240} />}
      >
        <ChartCard title="Velocity trend" description="Story points delivered per sprint" height={240}>
          <VelocityChart data={trendsQuery.data ?? []} />
        </ChartCard>
      </QueryBoundary>

      <QueryBoundary
        isLoading={sprintsQuery.isLoading}
        isError={sprintsQuery.isError}
        error={sprintsQuery.error}
        onRetry={() => sprintsQuery.refetch()}
        errorTitle="Unable to load sprints"
        skeleton={<ListSkeleton rows={3} height="h-32" className="space-y-3" />}
        isEmpty={paged.total === 0}
        empty={
          <Card>
            <EmptyState
              icon={Timer}
              title="No sprints yet"
              description="Sprint history appears here once the first sprint is planned."
              action={{ label: 'New sprint', onClick: () => setCreateOpen(true) }}
            />
          </Card>
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
                          <CardTitle>
                            <Link
                              to={`/agile?sprint=${sprint.id}`}
                              className="rounded transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {sprint.name}
                            </Link>
                          </CardTitle>
                          <SprintStateBadge state={sprint.state} />
                        </div>
                        <p className="mt-0.5 font-mono text-2xs tabular-nums text-muted-foreground">
                          {formatShortDate(sprint.startDate)} — {formatShortDate(sprint.endDate)}
                        </p>
                      </div>

                      <dl className="flex gap-6 text-right">
                        <div>
                          <dt className="epm-eyebrow">Committed</dt>
                          <dd className="font-mono text-sm font-semibold tabular-nums">
                            {formatNumber(sprint.committedPoints)}
                          </dd>
                        </div>
                        <div>
                          <dt className="epm-eyebrow">Completed</dt>
                          <dd className="font-mono text-sm font-semibold tabular-nums text-success">
                            {formatNumber(sprint.completedPoints)}
                          </dd>
                        </div>
                        <div>
                          <dt className="epm-eyebrow">Delivered</dt>
                          <dd className="font-mono text-sm font-semibold tabular-nums">
                            {formatPercent(progress)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-3 flex items-start gap-2.5 rounded-lg bg-muted/70 p-3">
                      <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                      <p className="text-2xs leading-relaxed text-muted-foreground">
                        {sprint.goal || 'No sprint goal has been set.'}
                      </p>
                    </div>

                    <div className="mt-3 space-y-1.5">
                      <ProgressBar
                        value={progress}
                        tone={sprint.state === 'completed' ? 'success' : 'primary'}
                        label={`${sprint.name} completion`}
                      />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-2xs text-muted-foreground">
                          {formatNumber(sprintProjects.length)}{' '}
                          {pluralize(sprintProjects.length, 'project')}:{' '}
                          {sprintProjects.map((project) => project.identifier).join(', ') || '—'}
                        </p>
                        <Button asChild variant="ghost" size="sm">
                          <Link to={`/agile?sprint=${sprint.id}`}>
                            Open
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          <Card>
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              onPageSizeChange={paged.setPageSize}
              pageSizeOptions={[8, 16, 32]}
              itemLabel="sprint"
            />
          </Card>
        </div>
      </QueryBoundary>
    </div>
  );
}
