import { useState } from 'react';
import { toast } from 'sonner';
import { Archive, Briefcase, Pencil, Plus, RotateCcw, Users } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { PortfolioDialog } from '@/components/portfolios/PortfolioDialog';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { usePortfolios, useSetPortfolioActive } from '@/hooks/usePortfolios';
import { useAuth } from '@/providers/AuthProvider';
import { pluralize } from '@/lib/utils';
import type { EpmPortfolio } from '@/services/api/portfolios';
import type { HealthLevel } from '@/types';

/**
 * The portfolio directory.
 *
 * Counts and health come from the projects each portfolio holds, read live —
 * nothing about a project is stored here. Everyone signed in can read; creating
 * and changing needs `portfolios:manage`, which the backend checks on every
 * write regardless of what is rendered.
 */

const LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];

export default function PortfoliosPage() {
  const { can } = useAuth();
  const mayManage = can('portfolios:manage');

  const [showArchived, setShowArchived] = useState(false);
  const portfolios = usePortfolios(showArchived);
  const setActive = useSetPortfolioActive();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmPortfolio>();

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (portfolio: EpmPortfolio) => {
    setEditing(portfolio);
    setDialogOpen(true);
  };

  const toggleActive = (portfolio: EpmPortfolio) => {
    const active = !portfolio.active;

    setActive.mutate(
      { id: portfolio.id, active },
      {
        onSuccess: () => toast.success(active ? 'Portfolio restored' : 'Portfolio archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const items = portfolios.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfolios"
        description="How delivery is grouped for reporting."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showArchived}
                onCheckedChange={setShowArchived}
                aria-label="Show archived portfolios"
              />
              Show archived
            </label>

            {mayManage ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New portfolio
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryBoundary
        isLoading={portfolios.isLoading}
        isError={portfolios.isError}
        onRetry={() => portfolios.refetch()}
        errorTitle="Unable to load portfolios"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        }
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={Briefcase}
            title={showArchived ? 'No portfolios' : 'No active portfolios'}
            description={
              mayManage
                ? 'Create a portfolio, then assign projects to it from each project.'
                : 'No portfolios have been set up yet.'
            }
          />
        }
      >
        <ul className="space-y-2">
          {items.map((portfolio) => (
            <li key={portfolio.id}>
              <Card className="flex items-center gap-4 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{portfolio.name}</span>
                    <Badge className="font-mono text-2xs">{portfolio.code}</Badge>
                    {!portfolio.active ? (
                      <Badge tone="warning" className="text-2xs">
                        Archived
                      </Badge>
                    ) : null}
                  </div>
                  {portfolio.description ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {portfolio.description}
                    </p>
                  ) : null}
                </div>

                <div className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  {portfolio.activeProjectCount} of{' '}
                  {pluralize(portfolio.projectCount, 'project')} active
                </div>

                {/* The distribution rather than a single verdict: collapsing
                    three states into one needs a rule nobody has specified. */}
                <div className="hidden shrink-0 items-center gap-2 sm:flex">
                  {LEVELS.map((level) => (
                    <span key={level} className="flex items-center gap-1">
                      <HealthIndicator level={level} />
                      <span className="font-mono text-2xs tabular-nums">
                        {portfolio.health[level]}
                      </span>
                    </span>
                  ))}
                </div>

                <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground lg:flex">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  {/* People across its projects, each counted once. */}
                  <span>
                    {portfolio.memberCount} · {portfolio.capacityHours} h/wk
                  </span>
                </div>

                {mayManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${portfolio.name}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openEdit(portfolio)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>

                    <button
                      type="button"
                      aria-label={
                        portfolio.active
                          ? `Archive ${portfolio.name}`
                          : `Restore ${portfolio.name}`
                      }
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => toggleActive(portfolio)}
                    >
                      {portfolio.active ? (
                        <Archive className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>
                  </div>
                ) : null}
              </Card>

              {/* Teams are derived from the members of this portfolio's
                  projects, not declared on it. */}
              {portfolio.teams.length > 0 ? (
                <p className="mt-1 px-4 text-2xs text-muted-foreground">
                  Teams involved: {portfolio.teams.map((team) => team.name).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </QueryBoundary>

      <PortfolioDialog open={dialogOpen} onOpenChange={setDialogOpen} portfolio={editing} />
    </div>
  );
}
