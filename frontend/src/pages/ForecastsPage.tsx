import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { t } from '@/lib/i18n';
import { formatCurrency, formatDateTime, formatNumber, formatPercent, formatShortDate } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { apiClient } from '@/services/api/client';

interface Factor {
  workPackageId: number;
  subject: string;
  drivesFinish: number;
}

interface Forecast {
  id: string;
  projectId: number;
  name: string;
  plannedFinish: string | null;
  probabilityOnTime: number | null;
  finish: { p10: string; p50: string; p90: string } | null;
  effort: { spentHours: number; atCompletionP50: number };
  cost: { spent: number; atCompletionP50: number | null; budget: number | null; probabilityOverBudget: number | null };
  factors: Factor[];
  trainedOn: { items: number };
  createdAt: string;
}

interface Evidence {
  kind: string;
  id: string;
  label: string;
  value?: string | number | null;
  link: string;
}

interface Recommendation {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  evidence: Evidence[];
  expectedEffect: { summary: string; before: number | string | null; after: number | string | null };
  change: { field: string; from: string | number | null; to: string | number };
  status: 'proposed' | 'applied' | 'rejected' | 'failed' | 'superseded';
  decidedAt: string | null;
  applyError: string | null;
}

interface Backtest {
  verdict: 'pass' | 'fail' | 'insufficient';
  basis: 'projects' | 'workPackages';
  tolerance: { brier: number; calibrationError: number; minCases: number };
  projects: { cases: number; brier: number | null; calibrationError: number | null };
  workPackages: { cases: number; brier: number | null; calibrationError: number | null };
  cutoffs: string[];
}

const probabilityTone = (value: number | null) => (value === null ? 'neutral' : value >= 0.7 ? 'success' : value >= 0.4 ? 'warning' : 'danger');
const effectValue = (value: number | string | null) => (typeof value === 'number' ? formatPercent(value * 100) : value ? formatShortDate(value) : '—');

/**
 * Delivery forecasts (BR-509, BR-510) and the actions they recommend (BR-511,
 * BR-512): how likely each project is to finish when planned, when it most
 * likely will, what it will cost, and what decides it — from the
 * organisation's own history. A recommendation changes nothing until someone
 * who may make its change approves it here.
 */
export default function ForecastsPage() {
  const { can } = useAuth();
  const admin = can('users:manage');
  const client = useQueryClient();
  const [params] = useSearchParams();
  const project = params.get('project') ?? undefined;
  const [comments, setComments] = useState<Record<string, string>>({});

  const forecasts = useQuery({
    queryKey: ['forecasts', project],
    queryFn: () => apiClient.get<{ run: { finishedAt: string | null; status: string } | null; forecasts: Forecast[] }>('/forecasts', project ? { projectId: project } : undefined),
  });
  const recommendations = useQuery({
    queryKey: ['recommendations', project],
    queryFn: () => apiClient.get<Recommendation[]>('/recommendations', project ? { projectId: project } : undefined),
  });
  const backtest = useQuery({ queryKey: ['forecasts', 'backtest'], queryFn: () => apiClient.get<{ backtest: Backtest | null }>('/forecasts/backtest'), enabled: admin });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['forecasts'] });
    void client.invalidateQueries({ queryKey: ['recommendations'] });
  };
  const run = useMutation({
    mutationFn: () => apiClient.post<{ projects: number; recommendations: number }>('/forecasts/run'),
    onSuccess: (outcome) => {
      toast.success(t('Forecasts made for {count, plural, one {# project} other {# projects}}', { count: outcome.projects }));
      refresh();
    },
    onError: () => toast.error(t('The forecasts could not be made')),
  });
  const test = useMutation({
    mutationFn: () => apiClient.post<Backtest>('/forecasts/backtest', {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['forecasts', 'backtest'] }),
    onError: () => toast.error(t('The back-test could not be run')),
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      apiClient.post<Recommendation>(`/recommendations/${input.id}/decision`, { decision: input.decision, comment: comments[input.id]?.trim() || null }),
    onSuccess: (outcome) => {
      if (outcome.status === 'applied') toast.success(t('Approved and applied'));
      else if (outcome.status === 'rejected') toast.success(t('Rejected; nothing was changed'));
      else toast.error(t('Approved, but the change was refused'), { description: outcome.applyError ?? undefined });
      refresh();
    },
    onError: (error) => toast.error(t('The decision was not recorded'), { description: error instanceof Error ? error.message : undefined }),
  });

  const proposed = (recommendations.data ?? []).filter((rec) => rec.status === 'proposed');
  const decided = (recommendations.data ?? []).filter((rec) => rec.status !== 'proposed').slice(0, 10);
  const lastRun = forecasts.data?.run;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('Insights')}
        title={t('Forecasts')}
        description={t('How likely each project is to finish when planned, when it most likely will and what it will cost — learnt from how your own work has actually finished. Recommendations change nothing until someone approves them.')}
        actions={
          admin ? (
            <Button loading={run.isPending} onClick={() => run.mutate()}>
              {t('Forecast now')}
            </Button>
          ) : undefined
        }
      />
      {lastRun?.finishedAt ? <p className="text-2xs text-muted-foreground">{t('Last forecast {when}; refreshed every six hours.', { when: formatDateTime(lastRun.finishedAt) })}</p> : null}

      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Projects')}</CardTitle>
          <CardDescription>{t('The chance of finishing by the planned finish, and the range it most likely finishes in (one in ten earlier, one in ten later).')}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto pt-4">
          <QueryBoundary isLoading={forecasts.isLoading} isError={forecasts.isError} error={forecasts.error} onRetry={() => void forecasts.refetch()} errorTitle={t('The forecasts could not be loaded')} skeleton={<ListSkeleton rows={4} />}>
            {(forecasts.data?.forecasts ?? []).length === 0 ? (
              <p className="text-2xs text-muted-foreground">{t('No forecasts yet: they are made for active projects with open work.')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Project')}</TableHead>
                    <TableHead>{t('Planned finish')}</TableHead>
                    <TableHead>{t('On time')}</TableHead>
                    <TableHead>{t('Likely finish')}</TableHead>
                    <TableHead>{t('Cost at completion')}</TableHead>
                    <TableHead>{t('What decides it')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecasts.data!.forecasts.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium" dir="auto">
                        <Link to={`/projects/${row.projectId}`} className="hover:underline">
                          {row.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-2xs">{row.plannedFinish ? formatShortDate(row.plannedFinish) : '—'}</TableCell>
                      <TableCell>
                        <Badge tone={probabilityTone(row.probabilityOnTime)} size="sm">
                          {row.probabilityOnTime === null ? '—' : formatPercent(row.probabilityOnTime * 100)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-2xs">
                        {row.finish ? (
                          <>
                            {formatShortDate(row.finish.p50)}
                            <span className="block text-muted-foreground">
                              {formatShortDate(row.finish.p10)} – {formatShortDate(row.finish.p90)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-2xs">
                        {row.cost.atCompletionP50 !== null ? formatCurrency(row.cost.atCompletionP50) : row.effort.atCompletionP50 > 0 ? t('{hours} h', { hours: formatNumber(row.effort.atCompletionP50) }) : '—'}
                        {row.cost.budget !== null ? (
                          <span className="block text-muted-foreground">
                            {t('of {budget}; {chance} over', { budget: formatCurrency(row.cost.budget), chance: row.cost.probabilityOverBudget === null ? '—' : formatPercent(row.cost.probabilityOverBudget * 100) })}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-2xs">
                        {row.factors.slice(0, 2).map((factor) => (
                          <Link key={factor.workPackageId} to={`/tasks/${factor.workPackageId}`} className="block truncate hover:underline" dir="auto">
                            {factor.subject} ({formatPercent(factor.drivesFinish * 100)})
                          </Link>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Recommended actions')}</CardTitle>
          <CardDescription>{t('Each cites the evidence it rests on and the effect expected. Approving applies its one change, as you and with your permissions; rejecting changes nothing. Both are journalled.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <QueryBoundary isLoading={recommendations.isLoading} isError={recommendations.isError} error={recommendations.error} onRetry={() => void recommendations.refetch()} errorTitle={t('The recommendations could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
            {proposed.length === 0 ? <p className="text-2xs text-muted-foreground">{t('No actions are recommended right now.')}</p> : null}
            {proposed.map((rec) => (
              <div key={rec.id} className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm font-medium" dir="auto">
                  {rec.title}
                </p>
                <p className="text-2xs text-muted-foreground" dir="auto">
                  {rec.rationale}
                </p>
                <ul className="space-y-0.5 text-2xs">
                  {rec.evidence.map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <Link to={item.link} className="hover:underline" dir="auto">
                        {item.label}
                      </Link>
                      {item.value !== undefined && item.value !== null ? <span className="text-muted-foreground"> — {String(item.value)}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="text-2xs">
                  {t('Expected effect: {summary} ({before} → {after})', { summary: rec.expectedEffect.summary, before: effectValue(rec.expectedEffect.before), after: effectValue(rec.expectedEffect.after) })}
                </p>
                <Textarea rows={2} placeholder={t('A note for the journal (optional)')} value={comments[rec.id] ?? ''} onChange={(event) => setComments({ ...comments, [rec.id]: event.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" loading={decide.isPending && decide.variables?.id === rec.id && decide.variables.decision === 'approve'} onClick={() => decide.mutate({ id: rec.id, decision: 'approve' })}>
                    {t('Approve and apply')}
                  </Button>
                  <Button size="sm" variant="secondary" loading={decide.isPending && decide.variables?.id === rec.id && decide.variables.decision === 'reject'} onClick={() => decide.mutate({ id: rec.id, decision: 'reject' })}>
                    {t('Reject')}
                  </Button>
                </div>
              </div>
            ))}
            {decided.length > 0 ? (
              <div className="space-y-1 pt-2">
                <p className="epm-eyebrow">{t('Decided')}</p>
                {decided.map((rec) => (
                  <p key={rec.id} className="text-2xs text-muted-foreground" dir="auto">
                    <Badge size="sm" tone={rec.status === 'applied' ? 'success' : rec.status === 'failed' ? 'danger' : 'neutral'}>
                      {rec.status === 'applied' ? t('Applied') : rec.status === 'rejected' ? t('Rejected') : rec.status === 'failed' ? t('Refused') : t('Superseded')}
                    </Badge>{' '}
                    {rec.title}
                    {rec.decidedAt ? ` · ${formatDateTime(rec.decidedAt)}` : ''}
                  </p>
                ))}
              </div>
            ) : null}
          </QueryBoundary>
        </CardContent>
      </Card>

      {admin ? (
        <Card>
          <CardHeader variant="compact">
            <CardTitle>{t('How good the forecasts are')}</CardTitle>
            <CardDescription>{t('A back-test forecasts again at dates in the past, from what was known then, and compares with what actually happened.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pt-4 text-2xs">
            {backtest.data?.backtest ? (
              (() => {
                const result = backtest.data.backtest!;
                const measured = result.basis === 'projects' ? result.projects : result.workPackages;
                return (
                  <>
                    <Badge tone={result.verdict === 'pass' ? 'success' : result.verdict === 'fail' ? 'danger' : 'neutral'} size="sm">
                      {result.verdict === 'pass' ? t('Within tolerance') : result.verdict === 'fail' ? t('Outside tolerance') : t('Not enough history yet')}
                    </Badge>
                    <p>
                      {t('{cases} cases ({basis}); Brier score {brier} (at most {brierTolerance}); calibration error {error} (at most {errorTolerance}).', {
                        cases: formatNumber(measured.cases),
                        basis: result.basis === 'projects' ? t('projects') : t('work packages'),
                        brier: measured.brier ?? '—',
                        brierTolerance: result.tolerance.brier,
                        error: measured.calibrationError ?? '—',
                        errorTolerance: result.tolerance.calibrationError,
                      })}
                    </p>
                    {result.verdict === 'insufficient' ? (
                      <p className="text-muted-foreground">{t('At least {count} finished cases are needed to judge; they build up as work is finished with due dates.', { count: result.tolerance.minCases })}</p>
                    ) : null}
                  </>
                );
              })()
            ) : (
              <p className="text-muted-foreground">{t('No back-test has been run yet.')}</p>
            )}
            <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>
              {t('Run a back-test')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
