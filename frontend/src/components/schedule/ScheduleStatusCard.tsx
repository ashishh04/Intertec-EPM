import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Clock, Network, RefreshCw, Route, Table2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecalculateSchedule, useScheduleStatus } from '@/hooks/useSchedule';
import { formatRelative } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';

/**
 * The critical path passes (BR-104): when the last one ran and why, how big
 * the network was, how long each step took, and whether OpenProject's
 * schedule fields are being written. Float is counted in the instance's
 * working days, which is why this sits with them.
 */
export function ScheduleStatusCard() {
  const status = useScheduleStatus();
  const recalculate = useRecalculateSchedule();
  const { can } = useAuth();

  if (status.isLoading) return <Skeleton className="h-28 w-full rounded-xl" />;
  if (!status.data) return null;
  const { enabled, mirrorEnabled, checkSeconds, lastCompleted, lastRun, pending } = status.data;
  const failed = lastRun?.status === 'failed' ? lastRun : undefined;

  const run = () =>
    recalculate.mutate(undefined, {
      onSuccess: (next) =>
        toast.success(next.pending ? t('Recalculating') : t('Recalculated'), {
          description: next.lastCompleted?.durationMs !== undefined && !next.pending
            ? t('{count, plural, other {# work packages in {ms, number} ms.}}', {
                count: next.lastCompleted.workPackages,
                ms: next.lastCompleted.durationMs,
              })
            : t('The figures update when the pass has run.'),
        }),
      onError: (error) => toast.error(t('Could not recalculate'), { description: error instanceof Error ? error.message : undefined }),
    });

  return (
    <Card data-testid="schedule-status">
      <CardHeader variant="compact">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('Critical path')}</CardTitle>
            <CardDescription>
              {t(
                '{seconds, plural, other {Total and free float are counted in the working days above. EPM recalculates them after every change it makes, and checks OpenProject every # seconds for changes made there.}}',
                { seconds: checkSeconds },
              )}
            </CardDescription>
          </div>
          {enabled && can('users:manage') ? (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={run} disabled={recalculate.isPending}>
              <RefreshCw className={recalculate.isPending || pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {t('Recalculate now')}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {!enabled ? (
          <Alert tone="neutral" title={t('Switched off on this server')}>
            {t('Float is neither computed nor shown. It is turned on with:')}{' '}
            <code className="text-2xs">EPM_SCHEDULE_ENABLED</code>
          </Alert>
        ) : null}
        {failed ? (
          <Alert
            tone="danger"
            title={t('The last pass failed {when}', { when: formatRelative(failed.finishedAt ?? failed.startedAt) })}
          >
            {failed.error ?? t('No reason was recorded.')} {t('The figures shown are the last good ones.')}
          </Alert>
        ) : null}
        {lastCompleted?.mirrorError ? (
          <Alert tone="warning" title={t('OpenProject\'s schedule fields are not being written')}>
            {lastCompleted.mirrorError}
          </Alert>
        ) : null}
        <div className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={Clock} title={t('Last pass')}>
            {lastCompleted ? formatRelative(lastCompleted.finishedAt ?? lastCompleted.startedAt) : t('None yet')}
            <span className="block text-2xs text-muted-foreground">
              {pending ? t('Another is on its way') : lastCompleted ? describeTrigger(lastCompleted.trigger) : ''}
            </span>
          </Fact>
          <Fact icon={Network} title={t('Network')}>
            {lastCompleted ? t('{count, plural, other {# work packages}}', { count: lastCompleted.workPackages }) : '—'}
            <span className="block text-2xs text-muted-foreground">
              {lastCompleted
                ? `${t('{count, number} scheduled', { count: lastCompleted.scheduled })} · ${t('{count, plural, one {# relation} other {# relations}}', { count: lastCompleted.relations })}` +
                  (lastCompleted.cycles.length ? ` · ${t('{count, plural, one {# loop} other {# loops}}', { count: lastCompleted.cycles.length })}` : '')
                : ''}
            </span>
          </Fact>
          <Fact icon={Route} title={t('Took')}>
            {lastCompleted?.durationMs !== undefined ? t('{ms, number} ms', { ms: lastCompleted.durationMs }) : '—'}
            <span className="block text-2xs text-muted-foreground">
              {lastCompleted
                ? t('read {read, number} · compute {compute, number} · store {store, number} · fields {fields, number} ms', {
                    read: lastCompleted.readMs ?? '—',
                    compute: lastCompleted.computeMs ?? '—',
                    store: lastCompleted.storeMs ?? '—',
                    fields: lastCompleted.mirrorMs ?? '—',
                  })
                : ''}
            </span>
          </Fact>
          <Fact icon={Table2} title={t('OpenProject\'s fields')}>
            {!mirrorEnabled ? t('Not written') : lastCompleted?.mirrorError ? t('Not written') : t('Written')}
            <span className="block text-2xs text-muted-foreground">
              {!mirrorEnabled
                ? t('{variable} is off', { variable: 'EPM_SCHEDULE_MIRROR_ENABLED' })
                : lastCompleted
                  ? t('{count, number} rewritten in the last pass', { count: lastCompleted.mirrored }) +
                    (lastCompleted.mirrorSkipped
                      ? ` · ${t('{count, number} of a type without them', { count: lastCompleted.mirrorSkipped })}`
                      : '')
                  : ''}
            </span>
          </Fact>
        </div>
      </CardContent>
    </Card>
  );
}

function describeTrigger(trigger: string): string {
  switch (trigger) {
    case 'change':
      return t('Started by a change made in EPM');
    case 'check':
      return t('Started by a change found in OpenProject');
    case 'manual':
      return t('Started by someone asking');
    case 'startup':
      return t('Started by the server starting');
    default:
      return t('Started by {trigger}', { trigger });
  }
}

function Fact({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="epm-eyebrow">{title}</p>
        <div className="mt-0.5 font-medium text-foreground">{children}</div>
      </div>
    </div>
  );
}
