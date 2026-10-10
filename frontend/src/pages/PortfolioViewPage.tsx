import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clock3, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { OverviewPeriodSelect, overviewQuery, type OverviewPeriodId } from '@/components/portfolios/OverviewPeriodSelect';
import { PortfolioOverviewPanel } from '@/components/portfolios/PortfolioOverviewPanel';
import { PortfolioViewDialog } from '@/components/portfolios/PortfolioViewDialog';
import { describeSelection, SharingBadge } from '@/components/portfolios/PortfolioViewSummary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeletePortfolioView, usePortfolioView, usePortfolioViewOverview, useSavePortfolioView } from '@/hooks/usePortfolioViews';
import { t } from '@/lib/i18n';
import { periodLabel } from '@/lib/report-periods';
import { formatDateTime, formatRelative } from '@/lib/utils';

/**
 * One saved portfolio view (BR-203), for the person opening it: the projects
 * it selects that they can see, with how many it left out, every figure
 * checked against its project rows and open on what made it.
 */
export default function PortfolioViewPage() {
  const { viewId } = useParams();
  const navigate = useNavigate();
  const view = usePortfolioView(viewId);
  const [period, setPeriod] = useState<OverviewPeriodId>('view');
  const overview = usePortfolioViewOverview(viewId, overviewQuery(period));
  const save = useSavePortfolioView();
  const remove = useDeletePortfolioView();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <QueryBoundary
      isLoading={view.isLoading}
      isError={view.isError}
      error={view.error}
      onRetry={() => view.refetch()}
      errorTitle={t('This view is not available to you')}
      skeleton={
        <div className="space-y-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      }
    >
      {view.data ? (
        <div className="space-y-5">
          <Link
            to="/portfolio-views"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t('All portfolio views')}
          </Link>

          <PageHeader
            eyebrow={t('Portfolio view')}
            title={view.data.name}
            description={view.data.description ?? describeSelection(view.data)}
            meta={
              <span className="flex flex-wrap items-center gap-2">
                <SharingBadge view={view.data} />
                {overview.data?.asOf ? (
                  <Badge tone="neutral" size="sm">
                    <Clock3 className="h-3 w-3" aria-hidden />
                    <span title={formatDateTime(overview.data.asOf)}>
                      {t('Data {when}', { when: formatRelative(overview.data.asOf) })}
                    </span>
                  </Badge>
                ) : null}
              </span>
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <OverviewPeriodSelect value={period} onChange={setPeriod} viewPeriodLabel={periodLabel(view.data.definition.periodPreset)} />
                {view.data.canEdit ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('Edit')}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={t('Delete this view')} onClick={() => setConfirming(true)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : null}
              </div>
            }
          />
          <p className="text-2xs text-muted-foreground">
            {view.data.mine ? t('Your view') : t('Shared by {name}', { name: view.data.owner.name })} · {describeSelection(view.data)}
          </p>

          <QueryBoundary
            isLoading={overview.isLoading}
            isError={overview.isError}
            error={overview.error}
            onRetry={() => overview.refetch()}
            errorTitle={t('Unable to build this view')}
            skeleton={<Skeleton className="h-96 w-full" />}
          >
            {overview.data ? (
              <PortfolioOverviewPanel overview={overview.data} columns={view.data.definition.columns} stale={overview.isPlaceholderData} />
            ) : null}
          </QueryBoundary>

          {editing ? (
            <PortfolioViewDialog
              id={view.data.id}
              initial={{
                name: view.data.name,
                description: view.data.description,
                visibility: view.data.visibility,
                roleIds: view.data.roleIds,
                definition: view.data.definition,
              }}
              saving={save.isPending}
              onClose={() => setEditing(false)}
              onSave={(input) =>
                save.mutate(
                  { id: view.data!.id, input },
                  {
                    onSuccess: () => {
                      toast.success(t('View saved'));
                      setEditing(false);
                    },
                    onError: (error) => toast.error(t('The view was not saved'), { description: error instanceof Error ? error.message : undefined }),
                  },
                )
              }
            />
          ) : null}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t('Delete "{name}"?', { name: view.data.name })}
            description={view.data.visibility === 'private' ? t('Only you could see it.') : t('Everyone it is shared with loses it too.')}
            confirmLabel={t('Delete')}
            tone="danger"
            pending={remove.isPending}
            onConfirm={() =>
              remove.mutate(view.data!.id, {
                onSuccess: () => {
                  toast.success(t('View deleted'));
                  navigate('/portfolio-views');
                },
                onError: (error) => toast.error(t('It could not be deleted'), { description: error instanceof Error ? error.message : undefined }),
              })
            }
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
