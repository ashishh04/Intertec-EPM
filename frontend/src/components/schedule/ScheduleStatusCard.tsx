import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Clock, Network, RefreshCw, Route, Table2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecalculateSchedule, useScheduleStatus } from '@/hooks/useSchedule';
import { formatNumber, formatRelative, pluralize } from '@/lib/utils';
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
        toast.success(next.pending ? 'Recalculating' : 'Recalculated', {
          description: next.lastCompleted?.durationMs !== undefined && !next.pending
            ? `${formatNumber(next.lastCompleted.workPackages)} work packages in ${formatNumber(next.lastCompleted.durationMs)} ms.`
            : 'The figures update when the pass has run.',
        }),
      onError: (error) => toast.error('Could not recalculate', { description: error instanceof Error ? error.message : undefined }),
    });

  return (
    <Card data-testid="schedule-status">
      <CardHeader variant="compact">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Critical path</CardTitle>
            <CardDescription>
              Total and free float are counted in the working days above. EPM recalculates them after every change it makes,
              and checks OpenProject every {checkSeconds} seconds for changes made there.
            </CardDescription>
          </div>
          {enabled && can('users:manage') ? (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={run} disabled={recalculate.isPending}>
              <RefreshCw className={recalculate.isPending || pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              Recalculate now
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {!enabled ? (
          <Alert tone="neutral" title="Switched off on this server">
            Float is neither computed nor shown. Set <code className="text-2xs">EPM_SCHEDULE_ENABLED</code> to turn it on.
          </Alert>
        ) : null}
        {failed ? (
          <Alert tone="danger" title={`The last pass failed ${formatRelative(failed.finishedAt ?? failed.startedAt)}`}>
            {failed.error ?? 'No reason was recorded.'} The figures shown are the last good ones.
          </Alert>
        ) : null}
        {lastCompleted?.mirrorError ? (
          <Alert tone="warning" title="OpenProject's schedule fields are not being written">
            {lastCompleted.mirrorError}
          </Alert>
        ) : null}
        <div className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={Clock} title="Last pass">
            {lastCompleted ? formatRelative(lastCompleted.finishedAt ?? lastCompleted.startedAt) : 'None yet'}
            <span className="block text-2xs text-muted-foreground">
              {pending ? 'Another is on its way' : lastCompleted ? `Started by ${describeTrigger(lastCompleted.trigger)}` : ''}
            </span>
          </Fact>
          <Fact icon={Network} title="Network">
            {lastCompleted ? `${formatNumber(lastCompleted.workPackages)} work packages` : '—'}
            <span className="block text-2xs text-muted-foreground">
              {lastCompleted
                ? `${formatNumber(lastCompleted.scheduled)} scheduled · ${formatNumber(lastCompleted.relations)} ${pluralize(lastCompleted.relations, 'relation')}` +
                  (lastCompleted.cycles.length ? ` · ${lastCompleted.cycles.length} ${pluralize(lastCompleted.cycles.length, 'loop')}` : '')
                : ''}
            </span>
          </Fact>
          <Fact icon={Route} title="Took">
            {lastCompleted?.durationMs !== undefined ? `${formatNumber(lastCompleted.durationMs)} ms` : '—'}
            <span className="block text-2xs text-muted-foreground">
              {lastCompleted
                ? `read ${lastCompleted.readMs ?? '—'} · compute ${lastCompleted.computeMs ?? '—'} · store ${lastCompleted.storeMs ?? '—'} · fields ${lastCompleted.mirrorMs ?? '—'} ms`
                : ''}
            </span>
          </Fact>
          <Fact icon={Table2} title="OpenProject's fields">
            {!mirrorEnabled ? 'Not written' : lastCompleted?.mirrorError ? 'Not written' : 'Written'}
            <span className="block text-2xs text-muted-foreground">
              {!mirrorEnabled
                ? 'EPM_SCHEDULE_MIRROR_ENABLED is off'
                : lastCompleted
                  ? `${formatNumber(lastCompleted.mirrored)} rewritten in the last pass` +
                    (lastCompleted.mirrorSkipped ? ` · ${formatNumber(lastCompleted.mirrorSkipped)} of a type without them` : '')
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
      return 'a change made in EPM';
    case 'check':
      return 'a change found in OpenProject';
    case 'manual':
      return 'someone asking';
    case 'startup':
      return 'the server starting';
    default:
      return trigger;
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
