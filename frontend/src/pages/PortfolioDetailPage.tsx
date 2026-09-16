import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Briefcase, FolderKanban, Pencil, RotateCcw, Users } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { PortfolioDialog } from '@/components/portfolios/PortfolioDialog';
import { DeliveryProgress, HealthBar, StatusBar } from '@/components/portfolios/PortfolioVisuals';
import { ProjectCardSkeleton, ProjectHealthCard } from '@/components/common/ProjectCard';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePagination } from '@/hooks/usePagination';
import { usePortfolio, usePortfolioProjects, useSetPortfolioActive } from '@/hooks/usePortfolios';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { TONE_VAR } from '@/lib/domain';
import { cn, formatNumber, pluralize } from '@/lib/utils';

/**
 * One portfolio.
 *
 * Every number here is rolled up from the projects the caller can see, read
 * live — the portfolio stores no copy of a project. So a project archived or
 * moved out upstream stops counting here without anything being told about it.
 */

const PAGE_SIZE = 9;

export default function PortfolioDetailPage() {
  const { portfolioId } = useParams();
  const { can } = useAuth();
  const mayManage = can('portfolios:manage');

  const portfolio = usePortfolio(portfolioId);
  const projects = usePortfolioProjects(portfolioId);
  const users = useUserMap();
  const setActive = useSetPortfolioActive();

  const [dialogOpen, setDialogOpen] = useState(false);

  const items = projects.data ?? [];
  const paged = usePagination(items, { pageSize: PAGE_SIZE });

  const toggleActive = () => {
    if (!portfolio.data) return;
    const active = !portfolio.data.active;

    setActive.mutate(
      { id: portfolio.data.id, active },
      {
        onSuccess: () => toast.success(active ? 'Portfolio restored' : 'Portfolio archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <QueryBoundary
      isLoading={portfolio.isLoading}
      isError={portfolio.isError}
      onRetry={() => portfolio.refetch()}
      errorTitle="Unable to load this portfolio"
      skeleton={
        <div className="space-y-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      {portfolio.data ? (
        <div className="space-y-5">
          <Link
            to="/portfolios"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All portfolios
          </Link>

          <PageHeader
            eyebrow={<span className="font-mono">{portfolio.data.code}</span>}
            title={portfolio.data.name}
            description={portfolio.data.description}
            meta={
              portfolio.data.active ? null : (
                <Badge tone="warning" size="sm">
                  Archived
                </Badge>
              )
            }
            actions={
              mayManage ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={setActive.isPending}
                    onClick={toggleActive}
                  >
                    {portfolio.data.active ? (
                      <Archive className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    {portfolio.data.active ? 'Archive' : 'Restore'}
                  </Button>
                </div>
              ) : null
            }
          />

          {/* Four figures rather than a chart: each is a single number, and a
              number is read faster as a number than as a mark. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card className="p-4">
              <p className="epm-eyebrow">Projects</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(portfolio.data.activeProjectCount)}
                <span className="ml-1 text-xs text-muted-foreground">
                  of {formatNumber(portfolio.data.projectCount)} active
                </span>
              </p>
            </Card>

            <Card className="p-4">
              <p className="epm-eyebrow">People</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(portfolio.data.memberCount)}
                <span className="ml-1 text-xs text-muted-foreground">
                  · {formatNumber(portfolio.data.capacityHours)} h/wk
                </span>
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Across its projects, counted once each.
              </p>
            </Card>

            <Card className="p-4">
              <p className="epm-eyebrow">Work</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(portfolio.data.taskCount)}
                <span className="ml-1 text-xs text-muted-foreground">
                  · {formatNumber(portfolio.data.completedTaskCount)} done
                </span>
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Work packages across its projects.
              </p>
            </Card>

            <Card className="p-4">
              <p className="epm-eyebrow">Open risks</p>
              <p
                className={cn(
                  'mt-1 font-mono text-lg tabular-nums',
                  portfolio.data.openRiskCount > 0 ? 'text-danger' : null,
                )}
              >
                {formatNumber(portfolio.data.openRiskCount)}
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                {portfolio.data.openRiskCount > 0
                  ? 'Overdue work packages.'
                  : 'Nothing overdue right now.'}
              </p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="space-y-3 p-4">
              <div>
                <p className="epm-eyebrow">Delivery progress</p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  Summed across its work, not averaged across its projects.
                </p>
              </div>
              <DeliveryProgress
                completed={portfolio.data.completedTaskCount}
                total={portfolio.data.taskCount}
              />
            </Card>

            <Card className="space-y-3 p-4">
              <div>
                <p className="epm-eyebrow">Project health</p>
                {/* The distribution rather than a single verdict: collapsing
                    three states into one needs a rule nobody has specified. */}
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  Effective health, counted rather than collapsed.
                </p>
              </div>
              {portfolio.data.projectCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No projects in this portfolio yet.
                </p>
              ) : (
                <HealthBar health={portfolio.data.health} showZero />
              )}
            </Card>

            <Card className="space-y-3 p-4">
              <div>
                <p className="epm-eyebrow">Delivery status</p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  Where each project stands against its plan.
                </p>
              </div>
              {portfolio.data.projectCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No projects in this portfolio yet.
                </p>
              ) : (
                <StatusBar statuses={portfolio.data.statuses} />
              )}
            </Card>
          </div>

          {/* Budget only when there is one. A portfolio with no figures
              recorded would otherwise show a confident "0 of 0". */}
          {portfolio.data.budgetTotal > 0 ? (
            <Card className="space-y-3 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <p className="epm-eyebrow">Budget</p>
                <p className="font-mono text-2xs tabular-nums text-muted-foreground">
                  {formatNumber(portfolio.data.budgetUsed)} of{' '}
                  {formatNumber(portfolio.data.budgetTotal)} used
                </p>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (portfolio.data.budgetUsed / portfolio.data.budgetTotal) * 100,
                      ),
                    )}%`,
                    background:
                      portfolio.data.budgetUsed > portfolio.data.budgetTotal
                        ? TONE_VAR.danger
                        : TONE_VAR.primary,
                  }}
                />
              </div>
              {portfolio.data.budgetUsed > portfolio.data.budgetTotal ? (
                <p className="text-2xs text-danger">
                  Spend has passed the recorded budget for this portfolio.
                </p>
              ) : null}
            </Card>
          ) : null}

          {/* Teams are derived from the members of this portfolio's projects,
              never declared on the portfolio itself. */}
          {portfolio.data.teams.length > 0 ? (
            <Card className="flex flex-wrap items-center gap-2 p-4">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" aria-hidden />
                Teams involved
              </span>
              {portfolio.data.teams.map((team) => (
                <Link key={team.id} to={`/teams/${team.id}`}>
                  <Badge size="sm" className="transition-colors hover:bg-muted">
                    {team.name}
                  </Badge>
                </Link>
              ))}
            </Card>
          ) : null}

          <div className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <FolderKanban className="h-4 w-4 text-muted-foreground" aria-hidden />
              Projects
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {formatNumber(items.length)} {pluralize(items.length, 'project')}
              </span>
            </h2>

            <QueryBoundary
              isLoading={projects.isLoading}
              isError={projects.isError}
              onRetry={() => projects.refetch()}
              errorTitle="Unable to load these projects"
              skeleton={
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <ProjectCardSkeleton />
                  <ProjectCardSkeleton />
                  <ProjectCardSkeleton />
                </div>
              }
              isEmpty={items.length === 0}
              empty={
                <EmptyState
                  icon={Briefcase}
                  title="No projects in this portfolio"
                  description="Open a project and set its portfolio from the overview tab to add it here."
                />
              }
            >
              <div className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {paged.items.map((project) => (
                    <ProjectHealthCard
                      key={project.id}
                      project={project}
                      users={users}
                    />
                  ))}
                </div>

                <Card className="px-1">
                  <Pagination
                    page={paged.page}
                    pageSize={paged.pageSize}
                    total={paged.total}
                    onPageChange={paged.setPage}
                    onPageSizeChange={paged.setPageSize}
                    pageSizeOptions={[9, 18, 36]}
                    itemLabel="project"
                  />
                </Card>
              </div>
            </QueryBoundary>
          </div>

          <PortfolioDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            portfolio={portfolio.data}
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
