import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CalendarCheck,
  Gauge,
  ShieldAlert,
  TrendingUp,
  Users,
} from 'lucide-react';
import { PageHeader, SectionHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import {
  DeliveryTrendChart,
  StatusDistributionChart,
  TrendChart,
  VelocityChart,
} from '@/components/charts/EpmCharts';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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
import { HEALTH_MATRIX_LABEL, HEALTH_META, TONE_FILL, TONE_TEXT } from '@/lib/domain';
import { cn } from '@/lib/utils';
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
      {live ? 'Live' : 'Snapshot history'}
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

  // Only asked for once there is something to ask about, so an empty database
  // does not produce a request per chart on every visit.
  const projectTrends = useTrends({ metrics: ['projects.active', 'projects.total'], days: 90 }, hasHistory);
  const healthTrends = useTrends(
    { metrics: ['health.healthy', 'health.warning', 'health.critical'], days: 90 },
    hasHistory,
  );
  const capacityTrends = useTrends({ metrics: ['capacity.hours', 'employees.mapped'], days: 90 }, hasHistory);

  const insightsQuery = useExecutiveInsights();
  const trendsQuery = useDeliveryTrends();
  const distributionQuery = useStatusDistribution();

  const insights = insightsQuery.data;

  // The health matrix carries one row per project, so it grows with the portfolio.

  const matrixPage = usePagination(insights?.matrix ?? [], { pageSize: 10 });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Executive"
        title="Delivery Intelligence"
        description="Portfolio health, delivery confidence and where attention is needed."
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.045 } } }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {insightsQuery.isLoading || !insights
          ? [0, 1, 2, 3, 4, 5].map((index) => <MetricCardSkeleton key={index} />)
          : [
              {
                label: 'Portfolio Health',
                value: insights.portfolioHealth,
                suffix: '%',
                support: 'Projects rated healthy overall',
                icon: Gauge,
                tone: 'success' as const,
              },
              {
                label: 'On-Time Delivery',
                value: insights.onTimeDelivery,
                suffix: '%',
                support: 'Milestones met on the committed date',
                icon: CalendarCheck,
                tone: 'primary' as const,
              },
              {
                label: 'Open Risks',
                value: insights.openRisks,
                support: 'Logged across active projects',
                icon: ShieldAlert,
                tone: 'warning' as const,
              },
              {
                label: 'Overdue Tasks',
                value: insights.overdueTasks,
                support: 'Past their committed date',
                icon: AlertTriangle,
                tone: 'danger' as const,
              },
              {
                label: 'Team Utilization',
                value: insights.teamUtilization,
                suffix: '%',
                support: insights.teamUtilization > 85 ? 'Above healthy capacity' : 'Within capacity',
                icon: Users,
                tone: insights.teamUtilization > 85 ? ('warning' as const) : ('accent' as const),
              },
              {
                label: 'Sprint Velocity',
                value: insights.sprintVelocity,
                suffix: 'pts',
                trend: insights.velocityTrend,
                icon: TrendingUp,
                tone: 'highlight' as const,
              },
            ].map((card) => (
              <motion.div
                key={card.label}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  show: { opacity: 1, y: 0, transition: { duration: 0.26 } },
                }}
              >
                <MetricCard {...card} />
              </motion.div>
            ))}
      </motion.div>

      {/* Portfolio health matrix */}
      <section className="space-y-3">
        <SectionHeader
          title="Portfolio health matrix"
          description="Schedule, scope and resource confidence per project"
        />

        <QueryBoundary
          isLoading={insightsQuery.isLoading}
          isError={insightsQuery.isError}
          error={insightsQuery.error}
          onRetry={() => insightsQuery.refetch()}
          errorTitle="Unable to load portfolio health"
          skeleton={<Skeleton className="h-72 w-full rounded-xl" />}
        >
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-48">Project</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Overall</TableHead>
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
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {row.identifier}
                          </span>
                          {row.projectName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <HealthCell level={row.schedule} />
                      </TableCell>
                      <TableCell>
                        <HealthCell level={row.scope} />
                      </TableCell>
                      <TableCell>
                        <HealthCell level={row.resources} />
                      </TableCell>
                      <TableCell>
                        <HealthCell level={row.overall} emphasis />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pagination
              page={matrixPage.page}
              pageSize={matrixPage.pageSize}
              total={matrixPage.total}
              onPageChange={matrixPage.setPage}
              itemLabel="project"
              className="border-t border-border"
            />

            <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
              {(['healthy', 'warning', 'critical'] as HealthLevel[]).map((level) => (
                <span key={level} className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', TONE_FILL[HEALTH_META[level].tone])} aria-hidden />
                  {HEALTH_MATRIX_LABEL[level]} — {HEALTH_META[level].label}
                </span>
              ))}
            </div>
          </Card>
        </QueryBoundary>
      </section>

      {/* Trends */}
      <section className="grid gap-4 lg:grid-cols-3">
        {trendsQuery.isLoading ? (
          <ChartCardSkeleton height={260} />
        ) : (
          <ChartCard
            title="Delivery throughput"
            description="Completed vs. created work packages"
            height={260}
            className="lg:col-span-2"
          >
            <DeliveryTrendChart data={trendsQuery.data ?? []} />
          </ChartCard>
        )}

        {distributionQuery.isLoading ? (
          <ChartCardSkeleton height={260} />
        ) : (
          <ChartCard title="Work distribution" description="Portfolio-wide status mix" height={260}>
            <StatusDistributionChart data={distributionQuery.data ?? []} />
          </ChartCard>
        )}
      </section>

      {trendsQuery.isLoading ? (
        <ChartCardSkeleton height={240} />
      ) : (
        <ChartCard title="Velocity" description="Story points delivered per sprint" height={240}>
          <VelocityChart data={trendsQuery.data ?? []} />
        </ChartCard>
      )}

      {/* Historical -------------------------------------------------------- */}
      <SectionHeader
        title="Trends"
        description={
          hasHistory
            ? // The last snapshot's date is what tells someone whether capture
              // is actually running. Read from coverage the API already returns.
              `Recorded snapshots, ${history?.firstSnapshot} to ${history?.lastSnapshot}` +
              ` · last capture ${history?.lastSnapshot}`
            : 'Recorded snapshots. History begins at the first capture.'
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
                      toast.success(`Captured ${result.records} metrics for ${result.sampledOn}`),
                    onError: (error) =>
                      toast.error('Could not capture a snapshot', {
                        description: error instanceof Error ? error.message : undefined,
                      }),
                  })
                }
              >
                Capture snapshot
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Projects over time"
          description="Active and total, per snapshot"
          height={240}
        >
          <TrendChart
            trends={projectTrends.data ?? []}
            unit="projects"
            labels={{ 'projects.active': 'Active', 'projects.total': 'Total' }}
            tones={['primary', 'neutral']}
          />
        </ChartCard>

        <ChartCard
          title="Health over time"
          description="Active projects by effective health"
          height={240}
        >
          <TrendChart
            trends={healthTrends.data ?? []}
            unit="projects"
            labels={{
              'health.healthy': 'Healthy',
              'health.warning': 'Warning',
              'health.critical': 'Critical',
            }}
            tones={['success', 'warning', 'danger']}
          />
        </ChartCard>

        <ChartCard
          title="Capacity over time"
          description="Weekly hours of mapped people"
          height={240}
          className="lg:col-span-2"
        >
          <TrendChart
            trends={capacityTrends.data ?? []}
            unit="h/wk"
            labels={{ 'capacity.hours': 'Capacity', 'employees.mapped': 'People mapped' }}
            tones={['accent', 'neutral']}
          />
        </ChartCard>
      </div>
    </div>
  );
}

function HealthCell({ level, emphasis = false }: { level: HealthLevel; emphasis?: boolean }) {
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
