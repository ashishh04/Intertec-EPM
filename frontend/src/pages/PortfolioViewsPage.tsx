import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { PortfolioViewDialog, blankView } from '@/components/portfolios/PortfolioViewDialog';
import { describeSelection, SharingBadge } from '@/components/portfolios/PortfolioViewSummary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDeletePortfolioView, usePortfolioViews, useSavePortfolioView } from '@/hooks/usePortfolioViews';
import { formatRelative } from '@/lib/utils';
import type { ID, PortfolioView, PortfolioViewInput } from '@/types';

/**
 * Saved portfolio views (BR-203): the ones you made, and the ones shared with
 * you — by a role you hold on one of their projects, or with everyone. Each
 * opens with your own access: a project in it you cannot see is left out.
 */

export default function PortfolioViewsPage() {
  const views = usePortfolioViews();
  const save = useSavePortfolioView();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{ id?: ID; input: PortfolioViewInput }>();

  const mine = (views.data ?? []).filter((view) => view.mine);
  const shared = (views.data ?? []).filter((view) => !view.mine);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Insights"
        title="Portfolio views"
        description="Saved selections of projects with their status, schedule, budget, risks and milestones in one view. Each person sees a view with their own access."
        actions={
          <Button size="sm" onClick={() => setEditing({ input: blankView() })}>
            <Plus className="h-3.5 w-3.5" />
            New view
          </Button>
        }
      />

      <QueryBoundary
        isLoading={views.isLoading}
        isError={views.isError}
        error={views.error}
        onRetry={() => views.refetch()}
        errorTitle="Unable to load the views"
        skeleton={<ListSkeleton rows={3} />}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <ViewList
            title="Yours"
            description="Views you made, shared or not."
            views={mine}
            empty="You have not saved a view yet. Open a portfolio and save it as a view, or start a new one."
          />
          <ViewList
            title="Shared with you"
            description="Views others share with everyone, or with a role you hold on one of their projects."
            views={shared}
            empty="Nobody has shared a view with you yet."
          />
        </div>
      </QueryBoundary>

      {editing ? (
        <PortfolioViewDialog
          id={editing.id}
          initial={editing.input}
          saving={save.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(input) =>
            save.mutate(
              { id: editing.id, input },
              {
                onSuccess: (saved) => {
                  toast.success(editing.id ? 'View saved' : 'View created');
                  setEditing(undefined);
                  if (!editing.id) navigate(`/portfolio-views/${saved.id}`);
                },
                onError: (error) => toast.error('The view was not saved', { description: error instanceof Error ? error.message : undefined }),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function ViewList({ title, description, views, empty }: { title: string; description: string; views: PortfolioView[]; empty: string }) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {views.length === 0 ? (
          <EmptyState size="inline" icon={Eye} title="No views here" description={empty} />
        ) : (
          <ul className="divide-y divide-border">
            {views.map((view) => (
              <ViewRow key={view.id} view={view} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ViewRow({ view }: { view: PortfolioView }) {
  const remove = useDeletePortfolioView();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Link to={`/portfolio-views/${view.id}`} className="hover:text-primary hover:underline">
            {view.name}
          </Link>
          <SharingBadge view={view} />
        </p>
        <p className="text-2xs text-muted-foreground">{describeSelection(view)}</p>
        <p className="text-2xs text-muted-foreground">
          {view.mine ? 'Yours' : `By ${view.owner.name}`} · changed {formatRelative(view.updatedAt)}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="secondary" asChild>
          <Link to={`/portfolio-views/${view.id}`}>Open</Link>
        </Button>
        {view.canEdit ? (
          <Button size="sm" variant="ghost" aria-label={`Delete ${view.name}`} onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete "${view.name}"?`}
        description={view.visibility === 'private' ? 'Only you could see it.' : 'Everyone it is shared with loses it too.'}
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(view.id, {
            onSuccess: () => {
              toast.success('View deleted');
              setConfirming(false);
            },
            onError: (error) => toast.error('It could not be deleted', { description: error instanceof Error ? error.message : undefined }),
          })
        }
      />
    </li>
  );
}
