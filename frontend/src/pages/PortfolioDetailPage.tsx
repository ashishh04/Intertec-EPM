import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, BookmarkPlus, Clock3, Pencil, RotateCcw, Users } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { PortfolioDialog } from '@/components/portfolios/PortfolioDialog';
import { OverviewPeriodSelect, overviewQuery, type OverviewPeriodId } from '@/components/portfolios/OverviewPeriodSelect';
import { PortfolioOverviewPanel } from '@/components/portfolios/PortfolioOverviewPanel';
import { blankView, PortfolioViewDialog } from '@/components/portfolios/PortfolioViewDialog';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortfolio, useSetPortfolioActive } from '@/hooks/usePortfolios';
import { usePortfolioOverview, useSavePortfolioView } from '@/hooks/usePortfolioViews';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';

/**
 * One portfolio in one view (BR-201): status, schedule variance, budget
 * consumption, open risks and where the milestones stand, for the portfolio
 * and for each project in it — every figure checked against its project rows
 * and open on what made it (BR-202). Built for the person looking: projects
 * they cannot see are left out and counted. It can be saved as a view and
 * shared (BR-203).
 */

export default function PortfolioDetailPage() {
  const { portfolioId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const mayManage = can('portfolios:manage');

  const portfolio = usePortfolio(portfolioId);
  const [period, setPeriod] = useState<OverviewPeriodId>('12w');
  const overview = usePortfolioOverview(portfolioId, overviewQuery(period));
  const setActive = useSetPortfolioActive();
  const saveView = useSavePortfolioView();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggleActive = () => {
    if (!portfolio.data) return;
    const active = !portfolio.data.active;

    setActive.mutate(
      { id: portfolio.data.id, active },
      {
        onSuccess: () => toast.success(active ? t('Portfolio restored') : t('Portfolio archived')),
        onError: (error) =>
          toast.error(t('That could not be changed'), {
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
      errorTitle={t('Unable to load this portfolio')}
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
            {t('All portfolios')}
          </Link>

          <PageHeader
            eyebrow={<span className="font-mono">{portfolio.data.code}</span>}
            title={portfolio.data.name}
            description={portfolio.data.description}
            meta={
              <span className="flex flex-wrap items-center gap-2">
                {portfolio.data.active ? null : (
                  <Badge tone="warning" size="sm">
                    {t('Archived')}
                  </Badge>
                )}
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
                <OverviewPeriodSelect value={period} onChange={setPeriod} />
                <Button size="sm" variant="secondary" onClick={() => setSaving(true)}>
                  <BookmarkPlus className="h-3.5 w-3.5" />
                  {t('Save as view')}
                </Button>
                {mayManage ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('Edit')}
                    </Button>
                    <Button size="sm" variant="ghost" loading={setActive.isPending} onClick={toggleActive}>
                      {portfolio.data.active ? <Archive className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {portfolio.data.active ? t('Archive') : t('Restore')}
                    </Button>
                  </>
                ) : null}
              </div>
            }
          />

          <QueryBoundary
            isLoading={overview.isLoading}
            isError={overview.isError}
            error={overview.error}
            onRetry={() => overview.refetch()}
            errorTitle={t('Unable to build this portfolio\'s figures')}
            skeleton={<Skeleton className="h-96 w-full" />}
          >
            {overview.data ? <PortfolioOverviewPanel overview={overview.data} stale={overview.isPlaceholderData} /> : null}
          </QueryBoundary>

          {/* Teams are derived from the members of this portfolio's projects,
              never declared on the portfolio itself. */}
          {portfolio.data.teams.length > 0 ? (
            <Card className="flex flex-wrap items-center gap-2 p-4">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {t('Teams involved')}
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

          <PortfolioDialog open={dialogOpen} onOpenChange={setDialogOpen} portfolio={portfolio.data} />

          {saving ? (
            <PortfolioViewDialog
              initial={blankView({ name: portfolio.data.name, portfolioIds: [portfolio.data.id] })}
              saving={saveView.isPending}
              onClose={() => setSaving(false)}
              onSave={(input) =>
                saveView.mutate(
                  { input },
                  {
                    onSuccess: (saved) => {
                      toast.success(t('View saved'));
                      setSaving(false);
                      navigate(`/portfolio-views/${saved.id}`);
                    },
                    onError: (error) =>
                      toast.error(t('The view was not saved'), { description: error instanceof Error ? error.message : undefined }),
                  },
                )
              }
            />
          ) : null}
        </div>
      ) : null}
    </QueryBoundary>
  );
}
