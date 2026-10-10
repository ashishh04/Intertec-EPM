import { useState } from 'react';
import { CheckCircle2, Database, History, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAnalyticsAccess,
  useAnalyticsModel,
  useCapture,
  useCaptures,
  useCompareCapture,
  useRefreshModel,
  useRefreshRuns,
} from '@/hooks/useInsights';
import { formatLocalNumber, t } from '@/lib/i18n';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { AnalyticsAccessProbe, AnalyticsRefreshRun, ReconciliationLine, ReconstructionCheck } from '@/types';
import { describeError } from './shared-format';

/**
 * The analytics model (BR-401, BR-402, BR-403): how fresh it is, every refresh
 * and how it reconciled to its source, the independent captures that history
 * is checked against, and whether the analytics role reads everything and
 * writes nothing. Behind `analytics:manage`.
 */
export default function AnalyticsModelPage() {
  const { can } = useAuth();
  const allowed = can('analytics:manage');

  if (!allowed) {
    return (
      <Alert tone="neutral" title={t('The analytics model is administered separately')}>
        {t('Refreshing the model and checking its history needs the analytics management permission.')}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <ModelStatusCard />
      <Tabs defaultValue="refreshes">
        <TabsList>
          <TabsTrigger value="refreshes">{t('Refreshes')}</TabsTrigger>
          <TabsTrigger value="history">{t('History')}</TabsTrigger>
          <TabsTrigger value="access">{t('Access')}</TabsTrigger>
        </TabsList>
        <TabsContent value="refreshes" className="mt-4 space-y-4">
          <ReconciliationCard />
          <RefreshLog />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryCard />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AccessCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const duration = (ms: number | null) =>
  ms === null
    ? '—'
    : t('{seconds} s', {
        seconds:
          ms < 10_000
            ? formatLocalNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
            : formatLocalNumber(Math.round(ms / 1000), { useGrouping: false }),
      });

/** How a refresh was set off, in words; an unknown value is shown as it came. */
const triggerName = (trigger: string) =>
  t('{trigger, select, change {change} manual {manual} schedule {schedule} other {{trigger}}}', { trigger });

function RunStatus({ run }: { run: AnalyticsRefreshRun }) {
  if (run.status === 'running') return <Badge tone="primary" size="sm">{t('Running')}</Badge>;
  if (run.status === 'failed') return <Badge tone="danger" size="sm" dot>{t('Failed')}</Badge>;
  if (run.reconciled === false) return <Badge tone="warning" size="sm" dot>{t('Did not reconcile')}</Badge>;
  return <Badge tone="success" size="sm" dot>{t('Succeeded')}</Badge>;
}

function ModelStatusCard() {
  const status = useAnalyticsModel(true);
  const refresh = useRefreshModel();

  const start = (kind: 'full' | 'incremental') =>
    refresh.mutate(kind, {
      onSuccess: () =>
        toast.success(kind === 'full' ? t('Full refresh started') : t('Refresh started'), {
          description: t('It appears in the log when it ends.'),
        }),
      onError: (error) => toast.error(t('The refresh could not start'), { description: describeError(error) }),
    });

  const data = status.data;
  const counts = data?.counts ?? {};

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => start('incremental')} disabled={refresh.isPending}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('Refresh now')}
            </Button>
            <Button size="sm" onClick={() => start('full')} disabled={refresh.isPending}>
              <Database className="h-3.5 w-3.5" />
              {t('Full refresh and reconcile')}
            </Button>
          </>
        }
      >
        <CardTitle>{t('Analytics model')}</CardTitle>
        <CardDescription>
          {t('The reporting model every dashboard reads, loaded from the instance and refreshed by itself: within a minute of a change, every {minutes} minutes regardless, and in full each night at {time} UTC.', {
            minutes: data?.intervalMinutes ?? 10,
            time: `${String(data?.fullRefreshHourUtc ?? 1).padStart(2, '0')}:00`,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <QueryBoundary
          isLoading={status.isLoading}
          isError={status.isError}
          error={status.error}
          onRetry={() => status.refetch()}
          errorTitle={t('Unable to read the model\'s state')}
          skeleton={<TableSkeleton columns={4} rows={2} />}
        >
          {data ? (
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Fact label={t('Data as of')} value={data.asOf ? formatRelative(data.asOf) : t('Never loaded')} hint={data.asOf ? formatDateTime(data.asOf) : undefined} />
              <Fact
                label={t('Last full refresh')}
                value={
                  data.lastFull
                    ? t('{duration} of {minutes} min', { duration: duration(data.lastFull.durationMs), minutes: data.windowMinutes })
                    : t('None yet')
                }
                hint={
                  data.lastFull
                    ? data.lastFull.withinWindow
                      ? t('{date} · within its window', { date: formatDateTime(data.lastFull.startedAt) })
                      : t('{date} · over its window', { date: formatDateTime(data.lastFull.startedAt) })
                    : undefined
                }
                badge={data.lastFull ? <RunStatus run={data.lastFull} /> : undefined}
              />
              <Fact
                label={t('Last refresh')}
                value={data.lastIncremental ? formatRelative(data.lastIncremental.startedAt) : t('None yet')}
                hint={data.lastIncremental ? `${duration(data.lastIncremental.durationMs)} · ${triggerName(data.lastIncremental.trigger)}` : undefined}
                badge={data.lastIncremental ? <RunStatus run={data.lastIncremental} /> : undefined}
              />
              <Fact
                label={t('Holds')}
                value={t('{count, number} work packages', { count: counts.work_packages ?? 0 })}
                hint={t('{versions, number} versions · {entries, number} time entries · {projects, number} projects', {
                  versions: counts.work_package_versions ?? 0,
                  entries: counts.time_entries ?? 0,
                  projects: counts.projects ?? 0,
                })}
              />
            </dl>
          ) : null}
          {data && !data.enabled ? (
            <Alert tone="warning" title={t('Refreshing is switched off')} className="mt-4">
              {t('EPM_ANALYTICS_MODEL_ENABLED is false, so the model stays as last loaded.')}
            </Alert>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value, hint, badge }: { label: string; value: string; hint?: string; badge?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="epm-eyebrow">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
        {value}
        {badge}
      </dd>
      {hint ? <dd className="text-2xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function ReconciliationTable({ lines }: { lines: ReconciliationLine[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('Table')}</TableHead>
          <TableHead numeric>{t('At source')}</TableHead>
          <TableHead numeric>{t('In the model')}</TableHead>
          <TableHead numeric>{t('Difference')}</TableHead>
          <TableHead numeric>{t('Allowed')}</TableHead>
          <TableHead>{t('Result')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.entity}>
            <TableCell className="font-medium">{line.label}</TableCell>
            <TableCell numeric>{formatNumber(line.source)}</TableCell>
            <TableCell numeric>{formatNumber(line.model)}</TableCell>
            <TableCell numeric>{line.difference > 0 ? `+${line.difference}` : line.difference}</TableCell>
            <TableCell numeric>{line.allowed}</TableCell>
            <TableCell>
              {line.ok ? (
                <Badge tone="success" size="sm" dot>{t('Reconciles')}</Badge>
              ) : (
                <Badge tone="danger" size="sm" dot>{t('Outside tolerance')}</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReconciliationCard() {
  const status = useAnalyticsModel(true);
  const full = status.data?.lastFull;
  return (
    <TableCard
      toolbar={
        <CardHeader variant="compact" className="border-0">
          <CardTitle>{t('Reconciliation')}</CardTitle>
          <CardDescription className="text-2xs">
            {full
              ? t('Each table of the last full refresh against its source, within {tolerance, number}% of the source, rounded up to whole rows. {date}.', {
                  tolerance: status.data?.tolerancePct ?? 0.5,
                  date: formatDateTime(full.startedAt),
                })
              : t('Each table of the last full refresh against its source, within {tolerance, number}% of the source, rounded up to whole rows.', {
                  tolerance: status.data?.tolerancePct ?? 0.5,
                })}
          </CardDescription>
        </CardHeader>
      }
    >
      {full?.reconciliation?.length ? (
        <ReconciliationTable lines={full.reconciliation} />
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {t('No full refresh has completed yet. One runs at startup and every night.')}
        </p>
      )}
    </TableCard>
  );
}

function RefreshLog() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const runs = useRefreshRuns(true, page, pageSize);
  const [open, setOpen] = useState<AnalyticsRefreshRun | undefined>();

  return (
    <>
      <TableCard
        toolbar={
          <CardHeader variant="compact" className="border-0">
            <CardTitle>{t('Refresh log')}</CardTitle>
            <CardDescription className="text-2xs">{t('Every refresh, what it loaded and how long it took.')}</CardDescription>
          </CardHeader>
        }
        footer={
          runs.data && runs.data.total > 0 ? (
            <Pagination
              page={runs.data.page}
              pageSize={pageSize}
              total={runs.data.total}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={[10, 15, 25, 50]}
              itemLabel={t('refresh')}
              itemLabelPlural={t('refreshes')}
            />
          ) : undefined
        }
      >
        <QueryBoundary
          isLoading={runs.isLoading}
          isError={runs.isError}
          error={runs.error}
          onRetry={() => runs.refetch()}
          errorTitle={t('Unable to load the refresh log')}
          skeleton={<TableSkeleton columns={6} rows={5} />}
          isEmpty={(runs.data?.total ?? 0) === 0}
          empty={<EmptyState size="inline" icon={History} title={t('No refreshes yet')} description={t('The first runs shortly after startup.')} />}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Started')}</TableHead>
                <TableHead>{t('Kind')}</TableHead>
                <TableHead>{t('Why')}</TableHead>
                <TableHead numeric>{t('Took')}</TableHead>
                <TableHead>{t('Result')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs.data?.items ?? []).map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(run.startedAt)}</TableCell>
                  <TableCell className="text-xs">{run.kind === 'full' ? t('Full') : t('Incremental')}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {run.trigger === 'change' ? t('A change') : run.trigger === 'manual' ? t('Asked for') : t('Schedule')}
                  </TableCell>
                  <TableCell numeric>{duration(run.durationMs)}</TableCell>
                  <TableCell>
                    <RunStatus run={run} />
                  </TableCell>
                  <TableCell className="text-end">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open?.id === run.id ? undefined : run)}>
                      {open?.id === run.id ? t('Hide') : t('Details')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryBoundary>
      </TableCard>
      {open ? (
        <Card>
          <CardHeader variant="compact">
            <CardTitle>
              {open.kind === 'full'
                ? t('Full refresh, {date}', { date: formatDateTime(open.startedAt) })
                : t('Incremental refresh, {date}', { date: formatDateTime(open.startedAt) })}
            </CardTitle>
            <CardDescription className="text-2xs">
              {open.error ??
                (open.windowMs
                  ? t('Took {duration}, against a window of {window}.', {
                      duration: duration(open.durationMs),
                      window: duration(open.windowMs),
                    })
                  : t('Took {duration}.', { duration: duration(open.durationMs) }))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {open.reconciliation?.length ? <ReconciliationTable lines={open.reconciliation} /> : null}
            {open.rows ? (
              <p className="text-2xs text-muted-foreground">
                {t('Loaded: {tables}', {
                  tables:
                    Object.entries(open.rows)
                      .filter(([key, value]) => !key.startsWith('model.') && value > 0)
                      .map(([key, value]) => `${key} ${formatNumber(value)}`)
                      .join(' · ') || t('nothing had changed'),
                })}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function HistoryCard() {
  const [page, setPage] = useState(1);
  const captures = useCaptures(true, page, 10);
  const capture = useCapture();
  const compare = useCompareCapture();
  const [result, setResult] = useState<ReconstructionCheck | undefined>();

  return (
    <div className="space-y-4">
      <TableCard
        toolbar={
          <CardHeader
            variant="compact"
            className="border-0"
            actions={
              <Button
                size="sm"
                variant="outline"
                disabled={capture.isPending}
                onClick={() =>
                  capture.mutate(undefined, {
                    onSuccess: (taken) =>
                      toast.success(t('Captured'), {
                        description: t('{count, number} work packages, as the instance reports them.', { count: taken.workPackages }),
                      }),
                    onError: (error) => toast.error(t('The capture failed'), { description: describeError(error) }),
                  })
                }
              >
                <History className="h-3.5 w-3.5" />
                {t('Capture now')}
              </Button>
            }
          >
            <CardTitle>{t('Captures')}</CardTitle>
            <CardDescription className="text-2xs">
              {t('Every work package as the instance reported it at a moment, taken daily without reference to the history. Compare one to check that the state rebuilt from history matches it field for field.')}
            </CardDescription>
          </CardHeader>
        }
        footer={
          captures.data && captures.data.total > 10 ? (
            <Pagination
              page={captures.data.page}
              pageSize={10}
              total={captures.data.total}
              onPageChange={setPage}
              onPageSizeChange={() => undefined}
              itemLabel={t('capture')}
              itemLabelPlural={t('captures')}
            />
          ) : undefined
        }
      >
        <QueryBoundary
          isLoading={captures.isLoading}
          isError={captures.isError}
          error={captures.error}
          onRetry={() => captures.refetch()}
          errorTitle={t('Unable to load the captures')}
          skeleton={<TableSkeleton columns={4} rows={4} />}
          isEmpty={(captures.data?.total ?? 0) === 0}
          empty={<EmptyState size="inline" icon={History} title={t('No captures yet')} description={t('One is taken every day; capture one now to compare.')} />}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Captured')}</TableHead>
                <TableHead>{t('By')}</TableHead>
                <TableHead numeric>{t('Work packages')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(captures.data?.items ?? []).map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-xs">{formatDateTime(item.capturedAt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.trigger === 'schedule' ? t('Schedule') : t('Asked for')}</TableCell>
                  <TableCell numeric>{formatNumber(item.workPackages)}</TableCell>
                  <TableCell className="text-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={compare.isPending}
                      onClick={() =>
                        compare.mutate(item.id, {
                          onSuccess: setResult,
                          onError: (error) => toast.error(t('The comparison failed'), { description: describeError(error) }),
                        })
                      }
                    >
                      {t('Compare')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryBoundary>
      </TableCard>

      {result ? (
        <Card>
          <CardHeader variant="compact">
            <CardTitle className="flex items-center gap-2">
              {result.matches ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <XCircle className="h-4 w-4 text-danger" aria-hidden />
              )}
              {result.matches
                ? t('Rebuilt from history matches the capture of {date}', { date: formatDateTime(result.capture.capturedAt) })
                : t('Rebuilt from history differs from the capture of {date}', { date: formatDateTime(result.capture.capturedAt) })}
            </CardTitle>
            <CardDescription className="text-2xs">
              {t('{compared, number} compared, {matched, number} identical, {mismatched, number} different.', {
                compared: result.compared,
                matched: result.matched,
                mismatched: result.mismatched,
              })}{' '}
              {result.deletedSince > 0
                ? `${t('{count} deleted since, so their history went with them.', { count: result.deletedSince })} `
                : ''}
              {result.missingFromHistory > 0
                ? `${t('{count} with no version for that instant.', { count: result.missingFromHistory })} `
                : ''}
              {t('Each work package is compared as at the moment its page was read.')}
            </CardDescription>
          </CardHeader>
          {result.differences.length > 0 ? (
            <CardContent className="pt-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Work package')}</TableHead>
                    <TableHead>{t('Field')}</TableHead>
                    <TableHead>{t('Captured')}</TableHead>
                    <TableHead>{t('Rebuilt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.differences.map((difference) => (
                    <TableRow key={`${difference.workPackageId}:${difference.field}`}>
                      <TableCell className="text-xs" dir="auto">#{difference.workPackageId} {difference.subject}</TableCell>
                      <TableCell className="text-xs">{difference.label}</TableCell>
                      <TableCell className="text-xs">{difference.captured ?? '—'}</TableCell>
                      <TableCell className="text-xs">{difference.reconstructed ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function ProbeList({ title, probes, refused }: { title: string; probes: AnalyticsAccessProbe[]; refused?: boolean }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <ul className="space-y-1.5">
        {probes.map((probe) => (
          <li key={probe.statement} className="flex items-start gap-2 text-xs">
            {probe.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
            )}
            <span>
              <span className="font-medium text-foreground">{probe.attempt}</span>
              {refused && probe.ok && probe.message ? (
                <span className="block text-2xs text-muted-foreground">
                  {probe.code
                    ? t('Refused ({code}): {message}', { code: probe.code, message: probe.message.replace(/^ERROR:\s*/, '') })
                    : t('Refused: {message}', { message: probe.message.replace(/^ERROR:\s*/, '') })}
                </span>
              ) : null}
              {!probe.ok && probe.message ? <span className="block text-2xs text-danger">{probe.message}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccessCard() {
  const access = useAnalyticsAccess(true);
  const data = access.data;
  const readsOk = data?.reads.filter((probe) => probe.ok).length ?? 0;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          <Button size="sm" variant="outline" onClick={() => access.refetch()} disabled={access.isFetching}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('Check again')}
          </Button>
        }
      >
        <CardTitle>{t('The analytics role')}</CardTitle>
        <CardDescription>
          {t('BI tools read a streaming replica as a role that may read the analytics schema and nothing else. This connects as that role, reads every table, then tries every kind of write.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <QueryBoundary
          isLoading={access.isLoading}
          isError={access.isError}
          error={access.error}
          onRetry={() => access.refetch()}
          errorTitle={t('Unable to run the check')}
          skeleton={<TableSkeleton columns={2} rows={4} />}
        >
          {data && !data.configured ? (
            <Alert tone="neutral" title={t('Not configured')}>
              {t('Set EPM_ANALYTICS_DATABASE_URL to the analytics role on the replica (see the deployment guide, “Analytics replica”) and this checks it.')}
            </Alert>
          ) : data ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {data.ok ? (
                  <Badge tone="success" dot>{t('Reads everything, writes nothing')}</Badge>
                ) : (
                  <Badge tone="danger" dot>{t('Check failed')}</Badge>
                )}
                <span className="text-muted-foreground">
                  {data.replica
                    ? typeof data.lagSeconds === 'number'
                      ? t('As {role} on the replica, {seconds} s behind', { role: data.role, seconds: Math.round(data.lagSeconds) })
                      : t('As {role} on the replica', { role: data.role })
                    : typeof data.lagSeconds === 'number'
                      ? t('As {role} — not a replica, {seconds} s behind', { role: data.role, seconds: Math.round(data.lagSeconds) })
                      : t('As {role} — not a replica', { role: data.role })}{' '}
                  ·{' '}
                  {formatDateTime(data.checkedAt)}
                </span>
              </div>
              {data.error ? <Alert tone="danger" title={t('Could not connect')}>{data.error}</Alert> : null}
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">{t('Reads')}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t('{read} of {total} tables and functions read.', { read: readsOk, total: data.reads.length })}
                  </p>
                  {data.reads.some((probe) => !probe.ok) ? (
                    <ProbeList title={t('Could not read')} probes={data.reads.filter((probe) => !probe.ok)} />
                  ) : null}
                </div>
                <ProbeList title={t('Writes, each refused')} probes={data.writes} refused />
                <ProbeList title={t('Privileges')} probes={data.grants} />
              </div>
            </div>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
