import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Clock3, Gauge, Undo2 } from 'lucide-react';

import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { MeasureSeriesChart } from '@/components/charts/EpmCharts';
import { DashboardTableCard } from '@/components/insights/DashboardTableCard';
import { DrillSheet } from '@/components/insights/DrillSheet';
import { formatMeasure } from '@/components/insights/format';
import { MeasureTile, MeasureTileSkeleton } from '@/components/insights/MeasureTile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDepartments } from '@/hooks/useDepartments';
import { useDashboard, useMeasureCatalogue } from '@/hooks/useInsights';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useProjects } from '@/hooks/useProjects';
import { useTeams } from '@/hooks/useTeams';
import { formatDateTime, formatRelative } from '@/lib/utils';
import type { DashboardId, MeasureScopeKind } from '@/types';

/**
 * The executive and PMO dashboards (BR-405).
 *
 * Five views over the semantic layer — portfolio health, delivery, resource
 * utilisation, budget and risk exposure — for the whole instance or any
 * portfolio, project, department, team or person, over any period. Every
 * figure is a measure defined once (BR-404), with its definition a hover away,
 * and every figure with members opens on them: a portfolio row opens the
 * portfolio, a project row the project, a work package itself.
 *
 * Scope and period live in the URL, so a view can be sent to someone and
 * opens the same for them — within what they may see.
 */

const DASHBOARDS: { id: DashboardId; label: string }[] = [
  { id: 'portfolio-health', label: 'Portfolio health' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'utilisation', label: 'Utilisation' },
  { id: 'budget', label: 'Budget' },
  { id: 'risk', label: 'Risk exposure' },
];

const PRESETS = [
  { id: '4w', label: 'Last 4 weeks', days: 28 },
  { id: '12w', label: 'Last 12 weeks', days: 84 },
  { id: '26w', label: 'Last 6 months', days: 182 },
  { id: '52w', label: 'Last 12 months', days: 365 },
] as const;

const DAY_MS = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export default function InsightsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const dashboardId = (DASHBOARDS.some((entry) => entry.id === params.dashboardId)
    ? params.dashboardId
    : 'portfolio-health') as DashboardId;

  const scope = search.get('scope') ?? 'instance';
  const today = isoDay(new Date());
  const to = search.get('to') ?? today;
  const from = search.get('from') ?? isoDay(new Date(Date.parse(to) - 83 * DAY_MS));
  const query = useMemo(() => ({ scope, from, to }), [scope, from, to]);

  const dashboard = useDashboard(dashboardId, query);
  const catalogue = useMeasureCatalogue();
  const definitions = useMemo(
    () => new Map((catalogue.data ?? []).map((measure) => [measure.id, measure.definition])),
    [catalogue.data],
  );
  const trendOf = useMemo(
    () => new Map((catalogue.data ?? []).map((measure) => [measure.id, measure.trend])),
    [catalogue.data],
  );

  const [drill, setDrill] = useState<string | undefined>();

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '' || (key === 'scope' && value === 'instance')) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next, { replace: false });
  };

  const setScope = (kind: MeasureScopeKind, id: string) => {
    setDrill(undefined);
    update({ scope: kind === 'instance' ? undefined : `${kind}:${id}` });
  };

  const presetId =
    to === today ? PRESETS.find((preset) => isoDay(new Date(Date.parse(to) - (preset.days - 1) * DAY_MS)) === from)?.id : undefined;

  const data = dashboard.data;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={data ? data.scope.name : 'Dashboards'}
        title={DASHBOARDS.find((entry) => entry.id === dashboardId)?.label ?? 'Dashboards'}
        description={
          data?.description ??
          'Portfolio health, delivery, utilisation, budget and risk. Every figure is defined once, and opens on what is behind it.'
        }
        meta={
          data?.asOf ? (
            <Badge tone="neutral" size="sm">
              <Clock3 className="h-3 w-3" aria-hidden />
              <span title={formatDateTime(data.asOf)}>Data {formatRelative(data.asOf)}</span>
            </Badge>
          ) : null
        }
        actions={
          scope !== 'instance' ? (
            <Button size="sm" variant="outline" onClick={() => setScope('instance', '')}>
              <Undo2 className="h-3.5 w-3.5" />
              All projects
            </Button>
          ) : null
        }
      />

      <Tabs value={dashboardId} onValueChange={(value) => navigate({ pathname: `/insights/${value}`, search: search.toString() })}>
        <TabsList className="flex-wrap">
          {DASHBOARDS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <ScopePicker scope={scope} personName={data?.scope.kind === 'person' ? data.scope.name : undefined} onChange={(value) => update({ scope: value })} />
        <div className="space-y-1.5">
          <Label htmlFor="insights-period">Period</Label>
          <Select
            value={presetId ?? 'custom'}
            onValueChange={(value) => {
              const preset = PRESETS.find((entry) => entry.id === value);
              if (preset) update({ to: undefined, from: isoDay(new Date(Date.parse(today) - (preset.days - 1) * DAY_MS)) });
            }}
          >
            <SelectTrigger id="insights-period" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Custom dates
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="insights-from">From</Label>
          <Input
            id="insights-from"
            type="date"
            className="h-8 text-xs"
            value={from}
            max={to}
            onChange={(event) => event.target.value && update({ from: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="insights-to">To</Label>
          <Input
            id="insights-to"
            type="date"
            className="h-8 text-xs"
            value={to}
            min={from}
            max={today}
            onChange={(event) => event.target.value && update({ to: event.target.value === today ? undefined : event.target.value })}
          />
        </div>
      </Card>

      <QueryBoundary
        isLoading={dashboard.isLoading}
        isError={dashboard.isError}
        error={dashboard.error}
        onRetry={() => dashboard.refetch()}
        errorTitle="Unable to load this dashboard"
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
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
                  return (
                    <ChartCard
                      key={series.id}
                      title={series.title}
                      description={`${series.bucket === 'week' ? 'By week' : 'By month'} · ${asAt ? 'as it stood at the end of each' : 'within each'}`}
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

            {data.tables.map((table) => (
              <DashboardTableCard
                key={table.id}
                table={table}
                definitions={definitions}
                onScope={setScope}
                resetKey={`${dashboardId}|${scope}|${from}|${to}`}
              />
            ))}

            <Definitions measureIds={data.tiles} definitions={definitions} labels={data.measures} />

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Gauge className="h-3 w-3" aria-hidden />
                Answered in {data.timing.serverMs} ms, against a target of {data.timing.targetMs} ms
                {data.timing.withinTarget ? '' : ' — over target'}
              </span>
              {data.asOf ? <span>Data read {formatDateTime(data.asOf)}; refreshed within a minute of each change.</span> : null}
            </p>
          </div>
        ) : null}
      </QueryBoundary>

      <DrillSheet measureId={drill} query={query} onClose={() => setDrill(undefined)} onScope={setScope} />
    </div>
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
        <CardTitle>How these are counted</CardTitle>
        <CardDescription className="text-2xs">
          Each figure is a measure of EPM&rsquo;s semantic layer: defined once, and the same wherever it is shown.
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

/** Instance, a portfolio, a project, a department or a team; a person only as drilled into. */
function ScopePicker({
  scope,
  personName,
  onChange,
}: {
  scope: string;
  personName?: string;
  onChange: (value: string) => void;
}) {
  const portfolios = usePortfolios();
  const projects = useProjects();
  const departments = useDepartments();
  const teams = useTeams();

  return (
    <div className="space-y-1.5">
      <Label htmlFor="insights-scope">Scope</Label>
      <Select value={scope} onValueChange={onChange}>
        <SelectTrigger id="insights-scope" className="h-8 text-xs">
          <SelectValue placeholder="All projects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="instance">All projects</SelectItem>
          {scope.startsWith('person:') ? (
            <SelectItem value={scope}>{personName ?? 'This person'}</SelectItem>
          ) : null}
          {(portfolios.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Portfolios</SelectLabel>
                {(portfolios.data ?? []).map((portfolio) => (
                  <SelectItem key={portfolio.id} value={`portfolio:${portfolio.id}`}>
                    {portfolio.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(projects.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Projects</SelectLabel>
                {(projects.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={`project:${project.id}`}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(departments.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Departments</SelectLabel>
                {(departments.data ?? []).map((department) => (
                  <SelectItem key={department.id} value={`department:${department.id}`}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(teams.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Teams</SelectLabel>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={`team:${team.id}`}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
