import { useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';

import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { MeasureLinesChart, MeasureSeriesChart } from '@/components/charts/EpmCharts';
import { BaselinesCard } from '@/components/insights/BaselinesCard';
import { DashboardTableCard } from '@/components/insights/DashboardTableCard';
import { DrillSheet } from '@/components/insights/DrillSheet';
import { formatMeasure } from '@/components/insights/format';
import { MeasureTile, MeasureTileSkeleton } from '@/components/insights/MeasureTile';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard, useMeasureCatalogue } from '@/hooks/useInsights';
import { formatLocalNumber, t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import type { InsightQuery } from '@/services/api/insights';
import type { DashboardId, MeasureScopeKind } from '@/types';

/**
 * One dashboard's figures, charts and tables for a scope and a period: the
 * tiles (each opening on what is behind it), the series, the tables whose
 * rows lead to their own scope, every definition, and how fast it answered.
 * The Dashboards page and a project's Dashboard tab both draw it.
 */
export function DashboardBody({
  dashboardId,
  query,
  onScope,
}: {
  dashboardId: DashboardId;
  query: InsightQuery;
  /** Where a row or a drilled item leads: another scope of the same dashboard. */
  onScope: (kind: MeasureScopeKind, id: string) => void;
}) {
  const dashboard = useDashboard(dashboardId, query);
  const catalogue = useMeasureCatalogue();
  const definitions = useMemo(() => new Map((catalogue.data ?? []).map((measure) => [measure.id, measure.definition])), [catalogue.data]);
  const trendOf = useMemo(() => new Map((catalogue.data ?? []).map((measure) => [measure.id, measure.trend])), [catalogue.data]);
  const [drill, setDrill] = useState<string | undefined>();
  const scope = query.scope ?? 'instance';
  const data = dashboard.data;

  const toScope = (kind: MeasureScopeKind, id: string) => {
    setDrill(undefined);
    onScope(kind, id);
  };

  return (
    <>
      <QueryBoundary
        isLoading={dashboard.isLoading}
        isError={dashboard.isError}
        error={dashboard.error}
        onRetry={() => dashboard.refetch()}
        errorTitle={t('Unable to load this dashboard')}
        skeleton={
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <MeasureTileSkeleton key={index} />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCardSkeleton />
              <ChartCardSkeleton />
            </div>
          </div>
        }
      >
        {data ? (
          <div className={dashboard.isPlaceholderData ? 'space-y-5 opacity-60 transition-opacity' : 'space-y-5'}>
            {/* Eight tiles sit in two rows of four rather than six and two. */}
            <div
              className={
                data.tiles.length === 8 ? 'grid grid-cols-2 gap-3 md:grid-cols-4' : 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'
              }
            >
              {data.tiles.map((id) => {
                const measure = data.measures[id];
                return measure ? <MeasureTile key={id} measure={measure} onOpen={() => setDrill(id)} /> : null;
              })}
            </div>

            {data.series.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {data.series.map((series) => {
                  const unit = data.measures[series.measureId]?.unit ?? catalogue.data?.find((entry) => entry.id === series.measureId)?.unit;
                  const asAt = trendOf.get(series.measureId) === 'asAt';
                  if (series.lines?.length) {
                    return (
                      <ChartCard
                        key={series.id}
                        title={series.title}
                        description={t(
                          '{bucket, select, week {By week} other {By month}} · as it stood at the end of each; ahead of today, the plan alone',
                          { bucket: series.bucket },
                        )}
                      >
                        <MeasureLinesChart
                          lines={[{ label: series.label ?? series.title, points: series.points }, ...series.lines]}
                          bucket={series.bucket}
                          index={unit === 'index'}
                          format={(value) => formatMeasure(value, unit)}
                        />
                      </ChartCard>
                    );
                  }
                  return (
                    <ChartCard
                      key={series.id}
                      title={series.title}
                      description={
                        asAt
                          ? t('{bucket, select, week {By week} other {By month}} · as it stood at the end of each', { bucket: series.bucket })
                          : t('{bucket, select, week {By week} other {By month}} · within each', { bucket: series.bucket })
                      }
                    >
                      <MeasureSeriesChart
                        points={series.points}
                        bucket={series.bucket}
                        kind={asAt ? 'line' : 'bars'}
                        label={series.title}
                        format={(value) => formatMeasure(value, unit)}
                      />
                    </ChartCard>
                  );
                })}
              </div>
            ) : null}

            {dashboardId === 'earned-value' && scope.startsWith('project:') ? <BaselinesCard projectId={scope.slice('project:'.length)} /> : null}

            {data.tables.map((table) => (
              <DashboardTableCard
                key={table.id}
                table={table}
                definitions={definitions}
                onScope={toScope}
                resetKey={`${dashboardId}|${scope}|${query.from}|${query.to}`}
              />
            ))}

            <Definitions measureIds={data.tiles} definitions={definitions} labels={data.measures} />

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Gauge className="h-3 w-3" aria-hidden />
                {data.timing.withinTarget
                  ? t('Answered in {server} ms, against a target of {target} ms', {
                      server: formatLocalNumber(data.timing.serverMs, { useGrouping: false }),
                      target: formatLocalNumber(data.timing.targetMs, { useGrouping: false }),
                    })
                  : t('Answered in {server} ms, against a target of {target} ms — over target', {
                      server: formatLocalNumber(data.timing.serverMs, { useGrouping: false }),
                      target: formatLocalNumber(data.timing.targetMs, { useGrouping: false }),
                    })}
              </span>
              {data.asOf ? <span>{t('Data read {when}; refreshed within a minute of each change.', { when: formatDateTime(data.asOf) })}</span> : null}
            </p>
          </div>
        ) : null}
      </QueryBoundary>

      <DrillSheet measureId={drill} query={query} onClose={() => setDrill(undefined)} onScope={toScope} />
    </>
  );
}

/** Every figure on the dashboard, with exactly what it counts. */
function Definitions({
  measureIds,
  definitions,
  labels,
}: {
  measureIds: string[];
  definitions: Map<string, string>;
  labels: Record<string, { label: string }>;
}) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('How these are counted')}</CardTitle>
        <CardDescription className="text-2xs">
          {t('Each figure is a measure of EPM’s semantic layer: defined once, and the same wherever it is shown.')}
        </CardDescription>
      </CardHeader>
      <dl className="grid gap-x-6 gap-y-3 p-4 pt-0 sm:grid-cols-2">
        {measureIds.map((id) => (
          <div key={id}>
            <dt className="text-xs font-semibold text-foreground">{labels[id]?.label ?? id}</dt>
            <dd className="text-2xs leading-relaxed text-muted-foreground">{definitions.get(id) ?? ''}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
