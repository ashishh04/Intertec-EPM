import { useState } from 'react';
import { toast } from 'sonner';
import { Briefcase, Plus } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { PortfolioCard, PortfolioCardSkeleton } from '@/components/portfolios/PortfolioCard';
import { PortfolioDialog } from '@/components/portfolios/PortfolioDialog';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { usePagination } from '@/hooks/usePagination';
import { useDeletePortfolio, usePortfolios, useSetPortfolioActive } from '@/hooks/usePortfolios';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmPortfolio } from '@/services/api/portfolios';

/**
 * The portfolio directory.
 *
 * Counts and health come from the projects each portfolio holds, read live —
 * nothing about a project is stored here. Everyone signed in can read; creating
 * and changing needs `portfolios:manage`, which the backend checks on every
 * write regardless of what is rendered.
 */

const PAGE_SIZE = 12;

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

  const [removing, setRemoving] = useState<EpmPortfolio>();
  const deletePortfolio = useDeletePortfolio();

  const confirmRemove = () => {
    if (!removing) return;
    const name = removing.name;

    deletePortfolio.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${name} deleted`);
        setRemoving(undefined);
      },
      onError: (error) =>
        toast.error('That could not be deleted', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
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

  // Only the page is local; it returns to the first page when the archived
  // toggle changes what the list holds.
  const paged = usePagination(items, { pageSize: PAGE_SIZE, resetKey: showArchived });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfolios"
        description="How delivery is grouped for reporting."
        actions={
          mayManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              New portfolio
            </Button>
          ) : null
        }
      />

      <ListToolbar trailing={<ResultCount count={items.length} label="portfolio" />}>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showArchived}
            onCheckedChange={setShowArchived}
            aria-label="Show archived portfolios"
          />
          Show archived
        </label>
      </ListToolbar>

      <QueryBoundary
        isLoading={portfolios.isLoading}
        isError={portfolios.isError}
        onRetry={() => portfolios.refetch()}
        errorTitle="Unable to load portfolios"
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <PortfolioCardSkeleton />
            <PortfolioCardSkeleton />
            <PortfolioCardSkeleton />
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
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {paged.items.map((portfolio) => (
              <PortfolioCard
                key={portfolio.id}
                portfolio={portfolio}
                mayManage={mayManage}
                onEdit={openEdit}
                onToggleActive={toggleActive}
                onRemove={setRemoving}
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
              pageSizeOptions={[12, 24, 48]}
              itemLabel="portfolio"
            />
          </Card>
        </div>
      </QueryBoundary>

      <PortfolioDialog open={dialogOpen} onOpenChange={setDialogOpen} portfolio={editing} />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              This removes the portfolio from EPM permanently. Archiving keeps it and can be
              undone; deleting cannot. It is refused if any project is still in it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={deletePortfolio.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={deletePortfolio.isPending}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
