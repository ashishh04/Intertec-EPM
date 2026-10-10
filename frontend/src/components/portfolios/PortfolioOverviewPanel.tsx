import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ChevronRight, CircleAlert, EyeOff, Inbox } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { MemberList } from '@/components/insights/DrillSheet';
import { formatMeasure } from '@/components/insights/format';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMeasureCatalogue, useMeasureMembers } from '@/hooks/useInsights';
import { useCostEntries } from '@/hooks/usePortfolioViews';
import { t } from '@/lib/i18n';
import { cn, formatNumber, formatShortDate } from '@/lib/utils';
import type { MeasureInfo, MeasureScopeKind, OverviewFigure, PortfolioOverview, PortfolioOverviewProject } from '@/types';

/**
 * A portfolio, or a saved view's projects, in one view (BR-201) — and every
 * figure in it opens on what made it (BR-202): the projects behind a figure,
 * and behind a project's share, its work packages or the priced time entries.
 * Each figure for the whole set is checked against its project rows, and the
 * view says whether they agree.
 */

/** The columns a set shows unless a saved view chooses others; matches the server's default. */
export const DEFAULT_COLUMNS = [
  'health',
  'schedule.varianceDays',
  'budget.consumed',
  'cost.variance',
  'risk.open',
  'milestones.missed',
  'milestones.upcoming',
  'work.overdue',
  'work.progress',
];

const GROUPS: { title: string; hint: string; primary: string; rows: string[] }[] = [
  { get title() { return t('Status'); }, get hint() { return t('Effective health of the active projects.'); }, primary: 'projects.atRisk', rows: ['health.green', 'health.amber', 'health.red'] },
  { get title() { return t('Schedule'); }, get hint() { return t('Forecast finish against the plan.'); }, primary: 'schedule.varianceDays', rows: ['schedule.slipping'] },
  {
    get title() { return t('Budget'); },
    get hint() { return t('Labour cost against the budgets.'); },
    primary: 'budget.consumed',
    rows: ['cost.actual', 'budget.total', 'cost.variance', 'budget.variancePct'],
  },
  { get title() { return t('Risks'); }, get hint() { return t('Open work packages of a risk type.'); }, primary: 'risk.open', rows: ['risk.high'] },
  { get title() { return t('Milestones'); }, get hint() { return t('Where the milestones stand.'); }, primary: 'milestones.missed', rows: ['milestones.upcoming', 'milestones.onTime'] },
];

type Drill = { measureId: string; projectId?: number };

/** Short column headings, so a row of figures fits; the full name and definition are in the tooltip. */
const SHORT: Record<string, string> = {
  get 'schedule.varianceDays'() { return t('Schedule'); },
  get 'schedule.slipping'() { return t('Slipping'); },
  get 'budget.total'() { return t('Budget'); },
  get 'budget.consumed'() { return t('Budget used'); },
  get 'budget.variancePct'() { return t('Budget var.'); },
  get 'cost.actual'() { return t('Actual cost'); },
  get 'cost.plannedToDate'() { return t('Planned'); },
  get 'cost.variance'() { return t('Cost var.'); },
  get 'risk.open'() { return t('Risks'); },
  get 'risk.high'() { return t('High risks'); },
  get 'milestones.missed'() { return t('Missed'); },
  get 'milestones.upcoming'() { return t('Coming up'); },
  get 'milestones.onTime'() { return t('On time'); },
  get 'work.open'() { return t('Open'); },
  get 'work.overdue'() { return t('Overdue'); },
  get 'work.progress'() { return t('Progress'); },
  get 'projects.atRisk'() { return t('At risk'); },
  get 'health.greenPct'() { return t('Green'); },
};

const money = (value: number | null | undefined) => formatMeasure(value ?? null, 'money');

/** What a figure was made from, in a few words, where its parts say more than the number. */
function partsText(measureId: string, figure: OverviewFigure | undefined): string | undefined {
  const parts = figure?.parts;
  if (!parts) return undefined;
  switch (measureId) {
    case 'budget.consumed':
      return t('{actual} of {budget}', { actual: money(parts.actual), budget: money(parts.budget) });
    case 'budget.variancePct':
      return t('{actual} spent, {planned} planned to date', { actual: money(parts.actual), planned: money(parts.planned) });
    case 'cost.variance':
      return t('{planned} planned, {actual} spent', { planned: money(parts.planned), actual: money(parts.actual) });
    case 'milestones.onTime':
      return t('{met, number} met, {missed, number} missed', { met: parts.met ?? 0, missed: parts.missed ?? 0 });
    case 'work.progress':
      return t('{closed, number} of {total, number} closed', { closed: parts.closed ?? 0, total: parts.total ?? 0 });
    case 'health.greenPct':
      return t('{green, number} of {assessed, number} assessed', { green: parts.green ?? 0, assessed: parts.assessed ?? 0 });
    case 'cost.actual':
      return (parts.uncostedHours ?? 0) > 0 ? t('{hours, number} h not costed', { hours: parts.uncostedHours ?? 0 }) : undefined;
    default:
      return undefined;
  }
}

const drillable = (measure: MeasureInfo | undefined) => Boolean(measure && (measure.memberKind || measure.entries));

export function PortfolioOverviewPanel({
  overview,
  columns = DEFAULT_COLUMNS,
  stale = false,
}: {
  overview: PortfolioOverview;
  columns?: string[];
  /** Showing the previous period's figures while the new ones load. */
  stale?: boolean;
}) {
  const catalogue = useMeasureCatalogue();
  const info = useMemo(() => new Map((catalogue.data ?? []).map((measure) => [measure.id, measure])), [catalogue.data]);
  const [drill, setDrill] = useState<Drill>();
  const mismatched = overview.reconciliation.filter((line) => !line.matches);
  const check = new Map(overview.reconciliation.map((line) => [line.measureId, line]));

  const figure = (id: string) => overview.measures[id];

  return (
    <div className={cn('space-y-4', stale && 'opacity-60 transition-opacity')}>
      <div className="flex flex-wrap items-center gap-2">
        {overview.reconciled ? (
          <Badge tone="success" size="sm" title={t('Each figure for the whole set equals the roll-up of the project rows below it.')}>
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            {t('Every figure adds up to its projects')}
          </Badge>
        ) : (
          <Badge tone="danger" size="sm">
            <CircleAlert className="h-3 w-3" aria-hidden />
            {t(
              '{count, plural, one {# figure does not add up to the projects} other {# figures do not add up to the projects}}',
              { count: mismatched.length },
            )}
          </Badge>
        )}
        <span className="text-2xs text-muted-foreground">
          {t('{count, plural, one {# project} other {# projects}}', { count: overview.set.shown })} · {formatShortDate(overview.period.from)} – {formatShortDate(overview.period.to)}
        </span>
      </div>

      {overview.set.hidden > 0 ? (
        <Alert tone="neutral" icon={EyeOff}>
          {t(
            '{hidden, plural, one {# of the {projects, number} projects in this {kind, select, view {view} other {portfolio}} is not shown: you do not have access to it. Every figure here leaves it out.} other {# of the {projects, number} projects in this {kind, select, view {view} other {portfolio}} are not shown: you do not have access to them. Every figure here leaves them out.}}',
            { hidden: overview.set.hidden, projects: overview.set.projects, kind: overview.set.kind },
          )}
        </Alert>
      ) : null}
      {overview.set.filtered > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t(
            '{count, plural, one {# project left out by this view’s health filter.} other {# projects left out by this view’s health filter.}}',
            { count: overview.set.filtered },
          )}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {GROUPS.map((group) => {
          const primary = figure(group.primary);
          const primaryInfo = info.get(group.primary);
          return (
            <Card key={group.title} className="flex flex-col gap-2 p-4">
              <div>
                <p className="epm-eyebrow">{group.title}</p>
                <p className="text-2xs text-muted-foreground">{group.hint}</p>
              </div>
              <button
                type="button"
                className="group text-start"
                onClick={() => setDrill({ measureId: group.primary })}
                title={primaryInfo?.definition}
              >
                <span className="block font-display text-2xl font-bold tabular-nums text-foreground group-hover:text-primary">
                  {formatMeasure(primary?.value ?? null, primary?.unit)}
                </span>
                <span className="block text-2xs text-muted-foreground">
                  {group.primary === 'projects.atRisk' && figure('projects.active')?.value !== null
                    ? t('{label} of {count, number} active', {
                        label: primary?.label ?? group.primary,
                        count: figure('projects.active')?.value ?? 0,
                      })
                    : (primary?.label ?? group.primary)}
                  {partsText(group.primary, primary) ? ` · ${partsText(group.primary, primary)}` : ''}
                </span>
              </button>
              <dl className="mt-auto space-y-1">
                {group.rows.map((id) => {
                  const row = figure(id);
                  return (
                    <div key={id} className="flex items-baseline justify-between gap-2">
                      <dt className="truncate text-2xs text-muted-foreground" title={info.get(id)?.definition}>
                        {row?.label ?? id}
                      </dt>
                      <dd>
                        <button
                          type="button"
                          className="font-mono text-xs tabular-nums text-foreground hover:text-primary hover:underline"
                          onClick={() => setDrill({ measureId: id })}
                        >
                          {formatMeasure(row?.value ?? null, row?.unit)}
                        </button>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        {overview.projects.length === 0 ? (
          <EmptyState
            size="inline"
            icon={Inbox}
            title={t('No projects to show')}
            description={overview.set.hidden > 0 ? t('None of the projects in this set is one you can see.') : t('This set has no active projects.')}
          />
        ) : (
          <div className="epm-scroll overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Project')}</TableHead>
                  {columns.map((column) => (
                    <TableHead
                      key={column}
                      numeric={column !== 'health'}
                      title={column === 'health' ? undefined : `${info.get(column)?.label ?? column}: ${info.get(column)?.definition ?? ''}`}
                    >
                      {column === 'health' ? t('Health') : (SHORT[column] ?? info.get(column)?.label ?? column)}
                    </TableHead>
                  ))}
                  <TableHead>{t('Next milestone')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    columns={columns}
                    info={info}
                    onDrill={(measureId) => setDrill({ measureId, projectId: project.id })}
                  />
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-xs font-semibold">{t('All {count, number} shown', { count: overview.projects.length })}</TableCell>
                  {columns.map((column) => {
                    if (column === 'health') return <TableCell key={column} />;
                    const line = check.get(column);
                    return (
                      <TableCell key={column} numeric>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-semibold hover:text-primary hover:underline"
                          onClick={() => setDrill({ measureId: column })}
                          title={
                            line
                              ? line.matches
                                ? t('Adds up: {rule}', { rule: info.get(column)?.rollup?.describe ?? line.rule })
                                : t('Does not add up: the projects make {value}', {
                                    value: formatMeasure(line.fromProjects, figure(column)?.unit),
                                  })
                              : undefined
                          }
                        >
                          {formatMeasure(figure(column)?.value ?? null, figure(column)?.unit)}
                          {line ? (
                            line.matches ? (
                              <CheckCircle2 className="h-3 w-3 text-success" aria-label={t('Adds up to the projects')} />
                            ) : (
                              <CircleAlert className="h-3 w-3 text-danger" aria-label={t('Does not add up to the projects')} />
                            )
                          ) : null}
                        </button>
                      </TableCell>
                    );
                  })}
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </Card>

      <PortfolioDrill overview={overview} info={info} drill={drill} onDrill={setDrill} onClose={() => setDrill(undefined)} />
    </div>
  );
}

function ProjectRow({
  project,
  columns,
  info,
  onDrill,
}: {
  project: PortfolioOverviewProject;
  columns: string[];
  info: Map<string, MeasureInfo>;
  onDrill: (measureId: string) => void;
}) {
  return (
    <TableRow>
      <TableCell className="max-w-56">
        <Link to={`/projects/${project.id}`} dir="auto" className="line-clamp-2 font-medium text-foreground hover:text-primary hover:underline">
          {project.name}
        </Link>
      </TableCell>
      {columns.map((column) => {
        if (column === 'health') {
          return (
            <TableCell key={column}>
              <HealthIndicator level={project.health} />
            </TableCell>
          );
        }
        const measure = info.get(column);
        const value = project.figures[column];
        const text = formatMeasure(value?.value ?? null, measure?.unit);
        return (
          <TableCell key={column} numeric title={value?.note ?? partsText(column, value)}>
            {drillable(measure) ? (
              <button type="button" className="tabular-nums hover:text-primary hover:underline" onClick={() => onDrill(column)}>
                {text}
              </button>
            ) : (
              <span className="tabular-nums">{text}</span>
            )}
          </TableCell>
        );
      })}
      <TableCell className="whitespace-nowrap text-xs">
        {project.nextMilestone ? (
          <Link to={`/tasks/${project.nextMilestone.id}`} className="hover:underline" title={project.nextMilestone.subject}>
            {formatShortDate(project.nextMilestone.dueDate)}
            <span className={cn('ms-1.5 text-2xs', project.nextMilestone.daysToGo < 0 ? 'text-danger' : 'text-muted-foreground')}>
              {project.nextMilestone.daysToGo < 0
                ? t('{days, number} d late', { days: -project.nextMilestone.daysToGo })
                : project.nextMilestone.daysToGo === 0
                  ? t('today')
                  : t('in {days, number} d', { days: project.nextMilestone.daysToGo })}
            </span>
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------------------------------------------------- */
/* The drill: a figure → its projects → the work or the time behind one        */
/* -------------------------------------------------------------------------- */

function PortfolioDrill({
  overview,
  info,
  drill,
  onDrill,
  onClose,
}: {
  overview: PortfolioOverview;
  info: Map<string, MeasureInfo>;
  drill: Drill | undefined;
  onDrill: (drill: Drill) => void;
  onClose: () => void;
}) {
  const measure = drill ? info.get(drill.measureId) : undefined;
  const whole = drill ? overview.measures[drill.measureId] : undefined;
  const project = drill?.projectId !== undefined ? overview.projects.find((item) => item.id === drill.projectId) : undefined;
  const line = drill ? overview.reconciliation.find((item) => item.measureId === drill.measureId) : undefined;
  const unit = whole?.unit ?? measure?.unit;

  return (
    <Sheet open={Boolean(drill)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border p-5 pe-12">
          <nav aria-label={t('Drill path')} className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
            <span dir="auto">{overview.set.name}</span>
            <ChevronRight className="h-3 w-3" aria-hidden />
            {project ? (
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => drill && onDrill({ measureId: drill.measureId })}>
                {whole?.label ?? measure?.label}
              </button>
            ) : (
              <span>{whole?.label ?? measure?.label}</span>
            )}
            {project ? (
              <>
                <ChevronRight className="h-3 w-3" aria-hidden />
                <span dir="auto">{project.name}</span>
              </>
            ) : null}
            <span className="ms-auto">
              {formatShortDate(overview.period.from)} – {formatShortDate(overview.period.to)}
            </span>
          </nav>
          <SheetTitle className="flex flex-wrap items-baseline gap-2">
            {project ? (
              <Button size="icon-sm" variant="ghost" aria-label={t('Back to the projects')} onClick={() => drill && onDrill({ measureId: drill.measureId })}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : null}
            {project ? project.name : (whole?.label ?? measure?.label)}
            <span className="font-display text-lg tabular-nums text-primary">
              {formatMeasure(project ? (project.figures[drill!.measureId]?.value ?? null) : (whole?.value ?? null), unit)}
            </span>
          </SheetTitle>
          <SheetDescription>{whole?.definition ?? measure?.definition ?? ' '}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {drill && !project ? (
            <ProjectsOfFigure overview={overview} measureId={drill.measureId} info={info} onProject={(projectId) => onDrill({ ...drill, projectId })} line={line} />
          ) : null}
          {drill && project ? <ProjectShare overview={overview} measure={measure} measureId={drill.measureId} projectId={project.id} onClose={onClose} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Level one: each project's share of the figure, and how they make the whole. */
function ProjectsOfFigure({
  overview,
  measureId,
  info,
  onProject,
  line,
}: {
  overview: PortfolioOverview;
  measureId: string;
  info: Map<string, MeasureInfo>;
  onProject: (projectId: number) => void;
  line: PortfolioOverview['reconciliation'][number] | undefined;
}) {
  const measure = info.get(measureId);
  const unit = overview.measures[measureId]?.unit ?? measure?.unit;
  const rows = [...overview.projects].sort(
    (a, b) => (b.figures[measureId]?.value ?? -Infinity) - (a.figures[measureId]?.value ?? -Infinity) || a.name.localeCompare(b.name),
  );

  return (
    <div className="space-y-3 p-5">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Project')}</TableHead>
            <TableHead numeric>{overview.measures[measureId]?.label ?? measure?.label}</TableHead>
            <TableHead>{t('Made of')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((project) => {
            const value = project.figures[measureId];
            return (
              <TableRow key={project.id} className="cursor-pointer" onClick={() => onProject(project.id)}>
                <TableCell className="font-medium" dir="auto">{project.name}</TableCell>
                <TableCell numeric className="tabular-nums">
                  {formatMeasure(value?.value ?? null, unit)}
                </TableCell>
                <TableCell className="text-2xs text-muted-foreground">{value?.note ?? partsText(measureId, value) ?? ''}</TableCell>
                <TableCell className="text-end">
                  <ChevronRight className="inline h-4 w-4 text-muted-foreground" aria-hidden />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="font-semibold">{t('All shown')}</TableCell>
            <TableCell numeric className="font-semibold tabular-nums">
              {formatMeasure(overview.measures[measureId]?.value ?? null, unit)}
            </TableCell>
            <TableCell colSpan={2} className="text-2xs text-muted-foreground">
              {partsText(measureId, overview.measures[measureId])}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      {line ? (
        <p className={cn('flex items-start gap-1.5 text-2xs', line.matches ? 'text-muted-foreground' : 'text-danger')}>
          {line.matches ? (
            <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-success" aria-hidden />
          ) : (
            <CircleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden />
          )}
          {line.matches
            ? t('Adds up: {rule}', { rule: measure?.rollup?.describe ?? line.rule })
            : t('Does not add up: the projects make {projects}, the whole is {whole}.', {
                projects: formatMeasure(line.fromProjects, unit),
                whole: formatMeasure(line.aggregate, unit),
              })}
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground">{t('This figure is not one that adds up across projects.')}</p>
      )}
    </div>
  );
}

/** Level two: what made one project's share — its work packages, people, or priced time entries. */
function ProjectShare({
  overview,
  measure,
  measureId,
  projectId,
  onClose,
}: {
  overview: PortfolioOverview;
  measure: MeasureInfo | undefined;
  measureId: string;
  projectId: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const query = { scope: `project:${projectId}`, from: overview.period.from, to: overview.period.to };
  const members = useMeasureMembers(measure?.memberKind && !measure.entries ? measureId : undefined, query);

  if (measure?.entries) return <CostEntriesList measureId={measureId} projectId={projectId} from={overview.period.from} to={overview.period.to} />;

  if (!measure?.memberKind) {
    return (
      <div className="space-y-2 p-5 text-xs text-muted-foreground">
        <p>{t('This figure is made from the project’s own plan, budget and health rather than from a list of items.')}</p>
        <Link to={`/projects/${projectId}`} onClick={onClose} className="font-medium text-primary hover:underline">
          {t('Open the project')}
        </Link>
      </div>
    );
  }

  return (
    <QueryBoundary
      isLoading={members.isLoading}
      isError={members.isError}
      error={members.error}
      onRetry={() => members.refetch()}
      errorTitle={t('Unable to load what is behind this figure')}
      skeleton={
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      }
      isEmpty={(members.data?.members.items.length ?? 0) === 0}
      empty={<EmptyState size="inline" icon={Inbox} title={t('Nothing behind this figure')} description={t('Nothing in this project matches the definition.')} />}
    >
      {members.data ? (
        <MemberList
          members={members.data.members}
          onScope={(kind: MeasureScopeKind, id: string) => {
            onClose();
            navigate({ pathname: '/insights/portfolio-health', search: `scope=${kind}:${id}` });
          }}
          onClose={onClose}
        />
      ) : null}
    </QueryBoundary>
  );
}

/** The priced time entries behind a cost figure (BR-202), as OpenProject lets this person see them. */
function CostEntriesList({ measureId, projectId, from, to }: { measureId: string; projectId: number; from: string; to: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const entries = useCostEntries(measureId, projectId, { from, to, page, pageSize });
  const data = entries.data;

  return (
    <QueryBoundary
      isLoading={entries.isLoading}
      isError={entries.isError}
      error={entries.error}
      onRetry={() => entries.refetch()}
      errorTitle={t('Unable to load the time entries')}
      skeleton={
        <div className="space-y-2 p-5">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      }
      isEmpty={(data?.total ?? 0) === 0}
      empty={<EmptyState size="inline" icon={Inbox} title={t('No time logged')} description={t('No time entry you can see is behind this figure.')} />}
    >
      {data ? (
        <div className="space-y-3 p-5">
          <p className={cn('flex items-start gap-1.5 text-2xs', data.figure.matches ? 'text-muted-foreground' : 'text-warning')}>
            {data.figure.matches ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-success" aria-hidden /> : <CircleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden />}
            {data.figure.matches
              ? t('These {count, number} entries make the project\'s labour cost: {cost}.', {
                  count: data.total,
                  cost: money(data.totals.cost),
                })
              : t(
                  'These {count, number} entries come to {cost}; the figure counts {actual} — some time on this project may not be visible to you, or was logged since the figures were read.',
                  { count: data.total, cost: money(data.totals.cost), actual: money(data.figure.actual) },
                )}
            {/* Without leave to read rates (BRL-01) the entries come without their
                cost: one entry's cost is one person's rate times their hours. */}
            {data.costHidden
              ? ` ${t('Each entry\'s cost is shown to people allowed to see hourly rates.')}`
              : data.totals.uncostedHours > 0
                ? ` ${t('{hours, number} h by people without an hourly rate are not costed.', { hours: data.totals.uncostedHours })}`
                : ''}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('Person')}</TableHead>
                <TableHead>{t('Work package')}</TableHead>
                <TableHead numeric>{t('Hours')}</TableHead>
                {data.costHidden ? null : <TableHead numeric>{t('Cost')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-xs">{formatShortDate(entry.spentOn)}</TableCell>
                  <TableCell className="text-xs" dir="auto">{entry.userName}</TableCell>
                  <TableCell className="max-w-56 text-xs">
                    {entry.workPackageId ? (
                      <Link to={`/tasks/${entry.workPackageId}`} dir="auto" className="line-clamp-1 hover:text-primary hover:underline">
                        {entry.workPackageSubject ?? `#${entry.workPackageId}`}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t('On the project')}</span>
                    )}
                  </TableCell>
                  <TableCell numeric className="tabular-nums">
                    {formatNumber(entry.hours)}
                  </TableCell>
                  {data.costHidden ? null : (
                    <TableCell numeric className="tabular-nums">
                      {entry.cost === null ? <span className="text-muted-foreground">{t('not costed')}</span> : money(entry.cost)}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-semibold">
                  {t('{count, plural, one {# entry} other {# entries}}', { count: data.total })}
                  {data.window.from ? ` · ${formatShortDate(data.window.from)} – ${formatShortDate(data.window.to ?? data.window.from)}` : ` · ${t('to date')}`}
                </TableCell>
                <TableCell numeric className="font-semibold tabular-nums">
                  {formatNumber(data.totals.hours)}
                </TableCell>
                {data.costHidden ? null : (
                  <TableCell numeric className="font-semibold tabular-nums">
                    {money(data.totals.cost)}
                  </TableCell>
                )}
              </TableRow>
            </TableFooter>
          </Table>
          {data.total > data.pageSize || page > 1 ? (
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={[25, 50, 100]}
              itemLabel={t('entry')}
              itemLabelPlural={t('entries')}
            />
          ) : null}
        </div>
      ) : null}
    </QueryBoundary>
  );
}
