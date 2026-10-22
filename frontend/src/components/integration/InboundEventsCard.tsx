import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { t } from '@/lib/i18n';
import { formatNumber, formatRelative } from '@/lib/utils';
import { apiClient } from '@/services/api/client';

type EventStatus = 'pending' | 'done' | 'failed' | 'dead';

interface InboundEvent {
  id: string;
  action: string;
  status: EventStatus;
  attempts: number;
  deliveries: number;
  lastError: string | null;
  receivedAt: string;
  nextAttemptAt: string | null;
}

interface InboundEvents {
  counts: Record<EventStatus, number>;
  events: InboundEvent[];
}

interface ReplayOutcome {
  replayed: number;
  done: number;
  failed: number;
}

const TONE: Record<EventStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  done: 'success',
  pending: 'neutral',
  failed: 'warning',
  dead: 'danger',
};

const label = (status: EventStatus) =>
  status === 'done' ? t('Processed') : status === 'pending' ? t('Waiting') : status === 'failed' ? t('Retrying') : t('Dead-lettered');

/**
 * Inbound events (BR-506): every delivery the instance's webhook made, kept
 * once and processed idempotently. What failed is retried on its own; what ran
 * out of retries waits here for an operator to replay — one, or all of them.
 */
export function InboundEventsCard() {
  const client = useQueryClient();
  const failing = useQuery({
    queryKey: ['integration', 'events', 'failing'],
    queryFn: async () => {
      const [dead, failed] = await Promise.all([
        apiClient.get<InboundEvents>('/integrations/events', { status: 'dead', limit: '50' }),
        apiClient.get<InboundEvents>('/integrations/events', { status: 'failed', limit: '50' }),
      ]);
      return { counts: dead.counts, events: [...dead.events, ...failed.events] };
    },
    refetchInterval: 60_000,
  });
  const done = (outcome: ReplayOutcome) => {
    toast.success(t('{count, plural, one {# event replayed} other {# events replayed}}: {done} processed', { count: outcome.replayed, done: outcome.done }));
    void client.invalidateQueries({ queryKey: ['integration', 'events'] });
  };
  const replayOne = useMutation({
    mutationFn: (id: string) => apiClient.post<ReplayOutcome>(`/integrations/events/${id}/replay`),
    onSuccess: done,
    onError: () => toast.error(t('The event could not be replayed')),
  });
  const replayDead = useMutation({
    mutationFn: () => apiClient.post<ReplayOutcome>('/integrations/events/replay', { status: 'dead' }),
    onSuccess: done,
    onError: () => toast.error(t('The events could not be replayed')),
  });
  const counts = failing.data?.counts;

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Inbound events')}</CardTitle>
        <CardDescription>
          {t('Every delivery is kept once and processed so that doing it again changes nothing. Failures are retried on their own; those that run out of retries wait here to be replayed.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <QueryBoundary
          isLoading={failing.isLoading}
          isError={failing.isError}
          error={failing.error}
          onRetry={() => void failing.refetch()}
          errorTitle={t('The inbound events could not be loaded')}
          skeleton={<ListSkeleton rows={3} />}
        >
          <div className="flex flex-wrap items-center gap-2">
            {(['done', 'failed', 'dead'] as EventStatus[]).map((status) => (
              <Badge key={status} tone={TONE[status]} size="sm" dot>
                {label(status)}: {formatNumber(counts?.[status] ?? 0)}
              </Badge>
            ))}
            {counts && counts.dead > 0 ? (
              <Button size="sm" variant="outline" className="ms-auto" loading={replayDead.isPending} onClick={() => replayDead.mutate()}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t('Replay all dead-lettered')}
              </Button>
            ) : null}
          </div>
          {(failing.data?.events ?? []).length === 0 ? (
            <p className="text-2xs text-muted-foreground">{t('Nothing has failed: every delivery was processed.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Event')}</TableHead>
                    <TableHead>{t('State')}</TableHead>
                    <TableHead>{t('Attempts')}</TableHead>
                    <TableHead>{t('Last error')}</TableHead>
                    <TableHead>{t('Received')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(failing.data?.events ?? []).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-mono text-2xs" dir="ltr">
                        {event.action}
                      </TableCell>
                      <TableCell>
                        <Badge tone={TONE[event.status]} size="sm">
                          {label(event.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-2xs">{formatNumber(event.attempts)}</TableCell>
                      <TableCell className="max-w-xs truncate text-2xs text-muted-foreground" dir="auto" title={event.lastError ?? ''}>
                        {event.lastError ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-2xs text-muted-foreground">{formatRelative(event.receivedAt)}</TableCell>
                      <TableCell className="text-end">
                        <Button size="sm" variant="ghost" loading={replayOne.isPending && replayOne.variables === event.id} onClick={() => replayOne.mutate(event.id)}>
                          {t('Replay')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
