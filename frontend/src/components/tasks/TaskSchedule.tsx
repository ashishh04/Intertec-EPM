import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Route } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRelations } from '@/hooks/useCollaboration';
import { useWorkPackageSchedule } from '@/hooks/useSchedule';
import { floatBand, floatLabel } from '@/lib/critical-path';
import { formatRelative, formatShortDate } from '@/lib/utils';
import type { ID, ScheduleLink } from '@/types';

/**
 * Where this work package sits in the schedule (BR-101, BR-103): its early
 * and late dates, its total and free float, and which predecessors hold it
 * back. Read-only: EPM computes these from the dates and relations, so the
 * way to change them is to change those.
 */
export function TaskSchedule({ workPackageId }: { workPackageId: ID }) {
  const schedule = useWorkPackageSchedule(workPackageId);
  const relations = useRelations(workPackageId);

  if (schedule.isError || (schedule.data && !schedule.data.enabled)) return null;

  const data = schedule.data;
  const item = data?.item;
  const band = floatBand(item, data?.nearCriticalDays ?? 0);
  const subjects = new Map((relations.data ?? []).map((relation) => [relation.related.id, relation.related.subject]));
  const driving = (data?.predecessors ?? []).filter((link) => link.driving);

  return (
    <Card data-testid="task-schedule">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Route className="h-4 w-4 text-muted-foreground" aria-hidden />
          Schedule
        </CardTitle>
        {item ? (
          band === 'critical' ? (
            <Badge tone="danger">On the critical path</Badge>
          ) : band === 'near' ? (
            <Badge tone="warning">Near-critical</Badge>
          ) : (
            <Badge tone="neutral">{floatLabel(item.totalFloat)}</Badge>
          )
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {schedule.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !item ? (
          <p className="text-xs text-muted-foreground">
            {data?.computedAt
              ? 'Not on the schedule: it needs a start date and a finish date in an active project.'
              : 'The schedule has not been calculated yet.'}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
              <Figure label="Total float" value={floatLabel(item.totalFloat)} hint="How far it can slip before the project finishes later." />
              <Figure label="Free float" value={floatLabel(item.freeFloat)} hint="How far it can slip before any successor has to move." />
              <Figure
                label="Early start – finish"
                value={`${formatShortDate(item.earlyStart)} – ${formatShortDate(item.earlyFinish)}`}
                hint="As soon as its predecessors allow."
              />
              <Figure
                label="Late start – finish"
                value={`${formatShortDate(item.lateStart)} – ${formatShortDate(item.lateFinish)}`}
                hint="As late as it can be without moving the finish."
              />
            </dl>
            {item.summary ? (
              <p className="text-2xs text-muted-foreground">A parent: these are its children's figures, rolled up.</p>
            ) : null}
            {item.inCycle ? (
              <p className="flex items-center gap-1.5 text-2xs text-warning-strong">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                It is in a loop of dependencies, so the relations inside the loop were left out of its figures.
              </p>
            ) : null}
            {driving.length > 0 ? (
              <p className="text-2xs text-muted-foreground">
                Held back by{' '}
                {driving.map((link: ScheduleLink, index) => (
                  <span key={link.id}>
                    {index > 0 ? ', ' : ''}
                    <Link to={`/tasks/${link.predecessorId}`} className="text-foreground underline-offset-2 hover:underline">
                      {subjects.get(link.predecessorId) ?? `#${link.predecessorId}`}
                    </Link>
                    {link.lag > 0 ? ` (+${link.lag} ${link.lag === 1 ? 'day' : 'days'} lag)` : ''}
                  </span>
                ))}
                .
              </p>
            ) : null}
          </>
        )}
        {data?.computedAt ? (
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            {data.pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {data.pending ? 'Recalculating · ' : ''}Computed {formatRelative(data.computedAt)}, in working days.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div title={hint}>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
