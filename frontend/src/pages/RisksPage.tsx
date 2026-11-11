import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ClipboardList, Plus, ShieldAlert, ShieldCheck, TimerReset, X } from 'lucide-react';

import { TableCard } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { StatusBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { RiskDialog } from '@/components/risks/RiskDialog';
import {
  CATEGORIES,
  RATINGS,
  RATING_TONE,
  SCALE,
  STAGE_TONE,
  categoryLabel,
  cellClass,
  impactLabel,
  probabilityLabel,
  ratingLabel,
  stageLabel,
} from '@/components/risks/riskMeta';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePagination } from '@/hooks/usePagination';
import { useProjects } from '@/hooks/useProjects';
import { useRiskRegister } from '@/hooks/useRisks';
import { useUserMap } from '@/hooks/useUsers';
import { cn, formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { RiskEntry, RiskRating } from '@/types';

/**
 * The risk register.
 *
 * Every risk in the projects the reader can see, scored on a five-by-five
 * matrix of probability and impact. A risk is a work item of the Risk type, so
 * its owner, status, dates and comments are where they always are; the
 * register adds its assessment and plan, and keeps its priority in step with
 * its rating, so the dashboards and project health count it the same way.
 *
 * The heat map narrows the list to one cell; the filters live in the address,
 * so a filtered register can be sent to someone.
 */

const ALL = '__all__';
const UNASSESSED = 'unassessed';

type StateFilter = 'open' | 'closed' | 'all';

export default function RisksPage() {
  const { canAnywhere } = useAuth();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('project') ?? ALL;
  const state = (['open', 'closed', 'all'].includes(search.get('state') ?? '') ? search.get('state') : 'open') as StateFilter;
  const rating = search.get('rating') ?? ALL;
  const cell = search.get('cell'); // "probability:impact"
  const [text, setText] = useState('');

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === ALL || (key === 'state' && value === 'open')) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next, { replace: true });
  };

  // Everything, open and closed: the counts and the heat map read the open
  // ones, and the list filters on the page.
  const register = useRiskRegister({ projectId: projectId === ALL ? undefined : projectId });
  const projects = useProjects();
  const users = useUserMap();
  const projectName = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );

  const [dialog, setDialog] = useState<{ open: boolean; risk?: RiskEntry }>({ open: false });

  const items = register.data?.items ?? [];
  const open = items.filter((entry) => entry.stage !== 'closed');

  const counts = {
    open: open.length,
    severe: open.filter((entry) => entry.rating === 'high' || entry.rating === 'critical').length,
    review: open.filter((entry) => entry.stage === 'review').length,
    unassessed: open.filter((entry) => entry.score === null).length,
  };

  const matrix = useMemo(() => {
    const byCell = new Map<string, number>();
    for (const entry of open) {
      const { probability, impact } = entry.assessment;
      if (probability === null || impact === null) continue;
      const key = `${probability}:${impact}`;
      byCell.set(key, (byCell.get(key) ?? 0) + 1);
    }
    return byCell;
  }, [open]);

  const byCategory = useMemo(() => {
    const tally = new Map<string, number>();
    for (const entry of open) {
      const key = entry.assessment.category ?? 'none';
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]);
  }, [open]);

  const needle = text.trim().toLowerCase();
  const shown = useMemo(
    () =>
      items
        .filter((entry) => (state === 'all' ? true : state === 'open' ? entry.stage !== 'closed' : entry.stage === 'closed'))
        .filter((entry) =>
          rating === ALL ? true : rating === UNASSESSED ? entry.rating === null : entry.rating === (rating as RiskRating),
        )
        .filter((entry) => {
          if (!cell) return true;
          const [probability, impact] = cell.split(':').map(Number);
          return entry.assessment.probability === probability && entry.assessment.impact === impact;
        })
        .filter(
          (entry) =>
            !needle ||
            entry.task.subject.toLowerCase().includes(needle) ||
            entry.task.key.toLowerCase().includes(needle),
        )
        // Worst first; unscored after scored; then the most recently changed.
        .sort(
          (a, b) =>
            (b.score ?? -1) - (a.score ?? -1) || (b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? ''),
        ),
    [items, state, rating, cell, needle],
  );

  const paged = usePagination(shown, { pageSize: 15, resetKey: `${projectId}|${state}|${rating}|${cell}|${needle}` });

  const configured = register.data?.configured ?? true;
  const mayRaise = canAnywhere('task:create') && configured && (register.data?.typeIds.length ?? 0) > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Risk register')}
        description={t(
          'Every risk in the projects you can see: how likely, how bad, and the plan for each. The worst come first.',
        )}
        actions={
          mayRaise ? (
            <Button size="sm" onClick={() => setDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              {t('New risk')}
            </Button>
          ) : null
        }
      />

      {!configured ? (
        <Alert tone="warning" title={t('The register is not set up on this server')}>
          {t(
            'Risks are kept as work items of the Risk type, which this server does not have yet. An administrator adds it with the governance types set-up described in the deployment guide.',
          )}
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={register.isLoading}
        isError={register.isError}
        error={register.error}
        onRetry={() => register.refetch()}
        errorTitle={t('Unable to load the risk register')}
        skeleton={
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <MetricCardSkeleton key={index} />
              ))}
            </div>
            <Skeleton className="h-72 w-full rounded-lg" />
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label={t('Open risks')}
              value={counts.open}
              icon={ShieldAlert}
              support={t('{count, number} closed', { count: items.length - counts.open })}
              onClick={() => update({ state: 'open', rating: undefined, cell: undefined })}
            />
            <MetricCard
              label={t('High and critical')}
              value={counts.severe}
              icon={AlertTriangle}
              tone={counts.severe > 0 ? 'danger' : 'success'}
              support={t('Rated 10 or more of 25')}
              onClick={() => update({ state: 'open', rating: 'high', cell: undefined })}
            />
            <MetricCard
              label={t('Due for review')}
              value={counts.review}
              icon={TimerReset}
              tone={counts.review > 0 ? 'warning' : 'success'}
              support={t('Their review date has passed')}
            />
            <MetricCard
              label={t('Not yet assessed')}
              value={counts.unassessed}
              icon={ClipboardList}
              tone={counts.unassessed > 0 ? 'warning' : 'success'}
              support={t('No probability or impact set')}
              onClick={() => update({ state: 'open', rating: UNASSESSED, cell: undefined })}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Heat map')}</CardTitle>
                <CardDescription className="text-2xs">
                  {t('Open risks by probability and impact. Choose a square to list the risks in it.')}
                </CardDescription>
              </CardHeader>
              <HeatMap
                counts={matrix}
                selected={cell}
                onSelect={(key) => update({ cell: key === cell ? undefined : key, state: 'open' })}
              />
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('By category')}</CardTitle>
                <CardDescription className="text-2xs">{t('Open risks, the most common category first.')}</CardDescription>
              </CardHeader>
              {byCategory.length === 0 ? (
                <p className="px-4 pb-6 pt-2 text-xs text-muted-foreground">{t('No open risks.')}</p>
              ) : (
                <ul className="space-y-2.5 px-4 pb-4">
                  {byCategory.map(([key, count]) => (
                    <li key={key} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          {key === 'none'
                            ? t('No category')
                            : CATEGORIES.includes(key as never)
                              ? categoryLabel(key as never)
                              : key}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{count}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.round((count / Math.max(1, counts.open)) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <ListToolbar
            trailing={<ResultCount count={shown.length} total={items.length} label={t('risk')} plural={t('risks')} />}
          >
            <SearchInput value={text} onValueChange={setText} placeholder={t('Search risks')} aria-label={t('Search risks')} />
            <Select value={projectId} onValueChange={(value) => update({ project: value, cell: undefined })}>
              <SelectTrigger className="h-8 w-48 text-xs" aria-label={t('Filter by project')}>
                <SelectValue placeholder={t('All projects')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('All projects')}</SelectItem>
                {(projects.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={rating} onValueChange={(value) => update({ rating: value })}>
              <SelectTrigger className="h-8 w-40 text-xs" aria-label={t('Filter by rating')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('Every rating')}</SelectItem>
                {RATINGS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {ratingLabel(value)}
                  </SelectItem>
                ))}
                <SelectItem value={UNASSESSED}>{t('Not yet assessed')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={(value) => update({ state: value })}>
              <SelectTrigger className="h-8 w-32 text-xs" aria-label={t('Filter by state')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t('Open')}</SelectItem>
                <SelectItem value="closed">{t('Closed')}</SelectItem>
                <SelectItem value="all">{t('All')}</SelectItem>
              </SelectContent>
            </Select>
            {cell ? (
              <Button size="sm" variant="secondary" onClick={() => update({ cell: undefined })}>
                {t('Probability {probability}, impact {impact}', {
                  probability: cell.split(':')[0],
                  impact: cell.split(':')[1],
                })}
                <X className="h-3 w-3" aria-hidden />
              </Button>
            ) : null}
          </ListToolbar>

          {shown.length === 0 ? (
            <Card>
              <EmptyState
                icon={ShieldCheck}
                title={items.length === 0 ? t('No risks yet') : t('No risks match')}
                description={
                  items.length === 0
                    ? mayRaise
                      ? t('Raise the first risk: what might happen, how likely it is and how bad it would be.')
                      : t('Nobody has raised a risk in the projects you can see.')
                    : t('Change the filters to see more.')
                }
              />
            </Card>
          ) : (
            <TableCard
              footer={
                shown.length > 15 ? (
                  <Pagination
                    page={paged.page}
                    pageSize={paged.pageSize}
                    total={paged.total}
                    onPageChange={paged.setPage}
                    onPageSizeChange={paged.setPageSize}
                    itemLabel={t('risk')}
                    itemLabelPlural={t('risks')}
                  />
                ) : undefined
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Risk')}</TableHead>
                    <TableHead>{t('Owner')}</TableHead>
                    <TableHead>{t('Score')}</TableHead>
                    <TableHead>{t('Stage')}</TableHead>
                    <TableHead>{t('Review on')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead className="w-0">
                      <span className="sr-only">{t('Actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.items.map((entry) => (
                    <TableRow key={entry.task.id}>
                      <TableCell className="max-w-[26rem]">
                        <Link to={`/tasks/${entry.task.id}`} className="group block min-w-0">
                          <span className="block truncate text-sm font-medium group-hover:text-primary" dir="auto">
                            {entry.task.subject}
                          </span>
                        </Link>
                        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                          <span className="shrink-0 font-mono">{entry.task.key}</span>
                          <span aria-hidden>·</span>
                          <Link to={`/projects/${entry.task.projectId}`} className="truncate hover:text-primary" dir="auto">
                            {projectName.get(entry.task.projectId) ?? t('Project')}
                          </Link>
                        </span>
                      </TableCell>
                      <TableCell>
                        {entry.task.assigneeId ? (
                          <span className="inline-flex items-center gap-2 text-xs">
                            <UserAvatarWithTooltip user={users.get(entry.task.assigneeId)} size="xs" />
                            <span className="hidden truncate xl:inline" dir="auto">
                              {users.get(entry.task.assigneeId)?.name}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('Unassigned')}</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {entry.score !== null && entry.rating && entry.assessment.probability && entry.assessment.impact ? (
                          <span className="inline-flex flex-col items-start gap-0.5">
                            <Badge tone={RATING_TONE[entry.rating]} size="sm" className="tabular-nums">
                              {t('{score, number} · {rating}', { score: entry.score, rating: ratingLabel(entry.rating) })}
                            </Badge>
                            <span
                              className="text-2xs text-muted-foreground"
                              title={t('Probability: {probability}. Impact: {impact}.', {
                                probability: probabilityLabel(entry.assessment.probability),
                                impact: impactLabel(entry.assessment.impact),
                              })}
                            >
                              {t('Probability {probability}, impact {impact}', {
                                probability: entry.assessment.probability,
                                impact: entry.assessment.impact,
                              })}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('Not assessed')}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge tone={STAGE_TONE[entry.stage]} size="sm" dot>
                          {stageLabel(entry)}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={cn('whitespace-nowrap text-xs', entry.stage === 'review' && 'font-medium text-warning-strong')}
                      >
                        {entry.assessment.reviewOn ? formatShortDate(entry.assessment.reviewOn) : '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={entry.task.statusCategory} label={entry.task.status.name} size="sm" />
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, risk: entry })}>
                          {t('Assess')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          )}

          {register.data?.truncated ? (
            <p className="text-2xs text-muted-foreground">
              {t('There are more risks than one page of the register holds: these are the most recently changed.')}
            </p>
          ) : null}
        </div>
      </QueryBoundary>

      <RiskDialog
        open={dialog.open}
        onOpenChange={(next) => setDialog((current) => ({ ...current, open: next }))}
        typeIds={register.data?.typeIds ?? []}
        risk={dialog.risk}
        defaultProjectId={projectId === ALL ? undefined : projectId}
      />
    </div>
  );
}

/**
 * Five by five: probability up the side (5 at the top), impact along the
 * bottom. Each square is coloured by the band its score falls in and shows how
 * many open risks sit there.
 */
function HeatMap({
  counts,
  selected,
  onSelect,
}: {
  counts: Map<string, number>;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const rows = [...SCALE].reverse();
  return (
    <div className="px-4 pb-4">
      <div className="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-1.5">
        {rows.map((probability) => (
          <Row key={probability} probability={probability} counts={counts} selected={selected} onSelect={onSelect} />
        ))}
        <span />
        {SCALE.map((impact) => (
          <span key={impact} className="truncate pt-1 text-center text-2xs text-muted-foreground" title={impactLabel(impact)}>
            {impact} · {impactLabel(impact)}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-2xs text-muted-foreground">
        <span>{t('Rows: probability')}</span>
        <span>{t('Columns: impact')}</span>
      </div>
    </div>
  );
}

function Row({
  probability,
  counts,
  selected,
  onSelect,
}: {
  probability: number;
  counts: Map<string, number>;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <>
      <span
        className="flex items-center justify-end whitespace-nowrap pe-1 text-2xs text-muted-foreground"
        title={probabilityLabel(probability)}
      >
        {probabilityLabel(probability)} · {probability}
      </span>
      {SCALE.map((impact) => {
        const key = `${probability}:${impact}`;
        const count = counts.get(key) ?? 0;
        const score = probability * impact;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            aria-pressed={selected === key}
            aria-label={t('Probability {probability}, impact {impact}: {count, plural, one {# risk} other {# risks}}', {
              probability,
              impact,
              count,
            })}
            className={cn(
              'flex h-11 items-center justify-center rounded-md text-sm font-semibold tabular-nums transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              cellClass(score),
              count === 0 && 'opacity-45',
              selected === key && 'ring-2 ring-foreground ring-offset-1 ring-offset-surface',
            )}
          >
            {count > 0 ? count : ''}
          </button>
        );
      })}
    </>
  );
}
