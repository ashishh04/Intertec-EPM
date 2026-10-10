import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Gauge } from 'lucide-react';
import { PageHeader, SectionHeader } from '@/components/common/PageHeader';
import { DrillSheet } from '@/components/insights/DrillSheet';
import { MeasureTile, MeasureTileSkeleton } from '@/components/insights/MeasureTile';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import {
  DeliveryTrendChart,
  StatusDistributionChart,
  TrendChart,
  VelocityChart,
} from '@/components/charts/EpmCharts';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useExecutiveInsights, useDeliveryTrends, useStatusDistribution } from '@/hooks/useReports';
import { useAnalyticsOverview, useCaptureSnapshot, useTrends } from '@/hooks/useAnalytics';
import { useAuth } from '@/providers/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { HEALTH_CRITERIA_META, HEALTH_MATRIX_LABEL, HEALTH_META, TONE_FILL, TONE_TEXT } from '@/lib/domain';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn, formatLongDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { HealthLevel } from '@/types';

/** Executive view: portfolio health, delivery confidence and the risk matrix. */
/**
 * Labels which claim a figure is making.
 *
 * A number computed from today's data and a number read from a recorded
 * snapshot are different assertions, and a reader who cannot tell them apart
 * will trust the wrong one.
 */
function SourceBadge({ live }: { live: boolean }) {
  return (
    <Badge tone={live ? 'primary' : 'neutral'} className="text-2xs">
      {live ? t('Live') : t('Snapshot history')}
    </Badge>
  );
}

export default function AnalyticsPage() {
  const { can } = useAuth();
  const mayCapture = can('analytics:manage');

  const overviewQuery = useAnalyticsOverview();
  const capture = useCaptureSnapshot();

  const history = overviewQuery.data?.history;
  const hasHistory = (history?.days ?? 0) > 0;
  // The snapshots count the whole organisation, whoever reads them, so the
  // API gives their series only to people who manage analytics (BRL-01).
  const mayReadHistory = mayCapture;

  // Only asked for once there is something to ask about, so an empty database
  // does not produce a request per chart on every visit.
  const loadTrends = hasHistory && mayReadHistory;
  const projectTrends = useTrends({ metrics: ['projects.active', 'projects.total'], days: 90 }, loadTrends);
  const healthTrends = useTrends(
    { metrics: ['health.healthy', 'health.warning', 'health.critical'], days: 90 },
    loadTrends,
  );
  const capacityTrends = useTrends({ metrics: ['capacity.hours', 'employees.mapped'], days: 90 }, loadTrends);

  const insightsQuery = useExecutiveInsights();
  const trendsQuery = useDeliveryTrends();
  const distributionQuery = useStatusDistribution();

  const insights = insightsQuery.data;
  const [drill, setDrill] = useState<string | undefined>();

  // The health matrix carries one row per project, so it grows with the portfolio.

  const matrixPage = usePagination(insights?.matrix ?? [], { pageSize: 10 });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('Executive')}
        title={t('Delivery Intelligence')}
        description={t('Portfolio health, delivery confidence and where attention is needed.')}
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.045 } } }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {insightsQuery.isLoading || !insights
          ? [0, 1, 2, 3, 4, 5].map((index) => <MeasureTileSkeleton key={index} />)
          : ['health.greenPct', 'milestones.onTime', 'risk.open', 'work.overdue', 'utilisation', 'sprint.velocity'].map(
              (id) => {
                const measure = insights.measures?.[id];
                return measure ? (
                  <motion.div
                    key={id}
                    variants={{
                      hidden: { opacity: 0, y: 8 },
                      show: { opacity: 1, y: 0, transition: { duration: 0.26 } },
                    }}
                  >
                    <MeasureTile measure={measure} onOpen={() => setDrill(id)} />
                  </motion.div>
                ) : null;
              },
            )}
      </motion.div>

      <DrillSheet measureId={drill} query={{}} onClose={() => setDrill(undefined)} onScope={() => setDrill(undefined)} />

      {/* Portfolio health matrix */}
      <section className="space-y-3">
        <SectionHeader
          title={t('Portfolio health matrix')}
          description={t('Each project on the health rules: schedule, budget, high risks and overdue work')}
        />

        <QueryBoundary
          isLoading={insightsQuery.isLoading}
          isError={insightsQuery.isError}
          error={insightsQuery.error}
          onRetry={() => insightsQuery.refetch()}
          errorTitle={t('Unable to load portfolio health')}
          skeleton={<TableSkeleton columns={5} rows={6} />}
          isEmpty={matrixPage.total === 0}
          empty={
            <Card>
              <EmptyState
                icon={Gauge}
                title={t('No projects to assess')}
                description={t('The matrix fills in once projects exist in the portfolio.')}
              />
            </Card>
          }
        >
          <TableCard
            footer={
              <>
                {/* The pager draws the divider itself, so nothing is doubled
                    when it renders nothing for a single page. */}
                <Pagination
                  page={matrixPage.page}
                  pageSize={matrixPage.pageSize}
                  total={matrixPage.total}
                  onPageChange={matrixPage.setPage}
                  itemLabel={t('project')}
                  itemLabelPlural={t('projects')}
                  className="border-b border-border"
                />
                <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-2xs text-muted-foreground">
                  {(['healthy', 'warning', 'critical'] as HealthLevel[]).map((level) => (
                    <span key={level} className="flex items-center gap-1.5">
                      <span
                        className={cn('h-2 w-2 rounded-full', TONE_FILL[HEALTH_META[level].tone])}
                        aria-hidden
                      />
                      {HEALTH_MATRIX_LABEL[level]} — {HEALTH_META[level].label}
                    </span>
                  ))}
                </div>
              </>
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">{t('Project')}</TableHead>
                  {HEALTH_CRITERIA_META.map((criterion) => (
                    <TableHead key={criterion.key}>{criterion.short}</TableHead>
                  ))}
                  <TableHead>{t('Overall')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrixPage.items.map((row) => (
                  <TableRow key={row.projectId} interactive>
                    <TableCell>
                      <Link
                        to={`/projects/${row.projectId}`}
                        className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                          {row.identifier}
                        </span>
                        {row.projectName}
                      </Link>
                    </TableCell>
                    {HEALTH_CRITERIA_META.map((criterion) => (
                      <TableCell key={criterion.key}>
                        <HealthCell level={row[criterion.key]} />
                      </TableCell>
                    ))}
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <HealthCell level={row.overall} emphasis />
                        {/* A pinned value is never shown as a measured one:
                            the calculated level and the reason travel with it. */}
                        {row.override ? (
                          <InfoTooltip
                            label={t('Overridden — calculated {level}. {reason}', {
                              level: HEALTH_MATRIX_LABEL[row.calculatedOverall],
                              reason: row.override.reason,
                            })}
                          >
                            <Badge tone="accent" className="text-2xs" tabIndex={0}>
                              {t('Pinned')}
                            </Badge>
                          </InfoTooltip>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </QueryBoundary>
      </section>

      {/* Trends */}
      <section className="grid gap-4 lg:grid-cols-3">
        {/* Empty series are drawn by the charts themselves, inside their
            cards, so the grid keeps its shape. */}
        <QueryBoundary
          isLoading={trendsQuery.isLoading}
          isError={trendsQuery.isError}
          error={trendsQuery.error}
          onRetry={() => trendsQuery.refetch()}
          errorTitle={t('Unable to load delivery throughput')}
          skeleton={<ChartCardSkeleton height={260} className="lg:col-span-2" />}
        >
          <ChartCard
            title={t('Delivery throughput')}
            description={t('Completed vs. created work packages')}
            height={260}
            className="lg:col-span-2"
          >
            <DeliveryTrendChart data={trendsQuery.data ?? []} />
          </ChartCard>
        </QueryBoundary>

        <QueryBoundary
          isLoading={distributionQuery.isLoading}
          isError={distributionQuery.isError}
          error={distributionQuery.error}
          onRetry={() => distributionQuery.refetch()}
          errorTitle={t('Unable to load work distribution')}
          skeleton={<ChartCardSkeleton height={260} />}
        >
          <ChartCard title={t('Work distribution')} description={t('Portfolio-wide status mix')} height={260}>
            <StatusDistributionChart data={distributionQuery.data ?? []} />
          </ChartCard>
        </QueryBoundary>
      </section>

      <QueryBoundary
        isLoading={trendsQuery.isLoading}
        isError={trendsQuery.isError}
        error={trendsQuery.error}
        onRetry={() => trendsQuery.refetch()}
        errorTitle={t('Unable to load velocity')}
        skeleton={<ChartCardSkeleton height={240} />}
      >
        <ChartCard title={t('Points delivered')} description={t('Story points of the work delivered each month')} height={240}>
          <VelocityChart data={trendsQuery.data ?? []} />
        </ChartCard>
      </QueryBoundary>

      {/* Historical -------------------------------------------------------- */}
      <SectionHeader
        title={t('Trends')}
        description={
          hasHistory
            ? // The last snapshot's date is what tells someone whether capture
              // is actually running. Read from coverage the API already returns.
              t('Recorded snapshots, {from} to {to} · last capture {last}', {
                from: formatLongDate(history?.firstSnapshot),
                to: formatLongDate(history?.lastSnapshot),
                last: formatLongDate(history?.lastSnapshot),
              })
            : t('Recorded snapshots. History begins at the first capture.')
        }
        actions={
          <div className="flex items-center gap-3">
            <SourceBadge live={false} />
            {mayCapture ? (
              <Button
                size="sm"
                variant="secondary"
                loading={capture.isPending}
                onClick={() =>
                  capture.mutate(undefined, {
                    onSuccess: (result) =>
                      toast.success(
                        t('Captured {records, number} metrics for {date}', {
                          records: result.records,
                          date: result.sampledOn,
                        }),
                      ),
                    onError: (error) =>
                      toast.error(t('Could not capture a snapshot'), {
                        description: error instanceof Error ? error.message : undefined,
                      }),
                  })
                }
              >
                {t('Capture snapshot')}
              </Button>
            ) : null}
          </div>
        }
      />

      {mayReadHistory ? (
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('Projects over time')}
          description={t('Active and total, per snapshot')}
          height={240}
        >
          <TrendChart
            trends={projectTrends.data ?? []}
            unit={t('projects')}
            labels={{ 'projects.active': t('Active'), 'projects.total': t('Total') }}
            tones={['primary', 'neutral']}
          />
        </ChartCard>

        <ChartCard
          title={t('Health over time')}
          description={t('Active projects by effective health')}
          height={240}
        >
          <TrendChart
            trends={healthTrends.data ?? []}
            unit={t('projects')}
            labels={{
              'health.healthy': t('Healthy'),
              'health.warning': t('Warning'),
              'health.critical': t('Critical'),
            }}
            tones={['success', 'warning', 'danger']}
          />
        </ChartCard>

        <ChartCard
          title={t('Capacity over time')}
          description={t('Weekly hours of mapped people')}
          height={240}
          className="lg:col-span-2"
        >
          <TrendChart
            trends={capacityTrends.data ?? []}
            unit={t('h/wk')}
            labels={{ 'capacity.hours': t('Capacity'), 'employees.mapped': t('People mapped') }}
            tones={['accent', 'neutral']}
          />
        </ChartCard>
      </div>
      ) : (
        <Card className="p-5 text-sm text-muted-foreground">
          {t('These snapshots count every project and person in the organisation, so they are shown to people who manage analytics.')}{' '}
          {t('Your own view, limited to the projects you can see, is under')}{' '}
          <Link to="/insights" className="font-medium text-primary underline-offset-2 hover:underline">
            {t('Insights')}
          </Link>
          .
        </Card>
      )}
    </div>
  );
}

function HealthCell({ level, emphasis = false }: { level: HealthLevel | null; emphasis?: boolean }) {
  if (level === null) {
    // Not assessed: nothing to measure against yet, which is not the same as good.
    return <span className="text-xs text-muted-foreground">{t('n/a')}</span>;
  }
  const meta = HEALTH_META[level];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        emphasis ? 'font-semibold' : 'font-medium',
        TONE_TEXT[meta.tone],
      )}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_FILL[meta.tone])} aria-hidden />
      {HEALTH_MATRIX_LABEL[level]}
    </span>
  );
}
