import { Link } from 'react-router-dom';
import { ArrowRight, Flag } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { BurndownChart } from '@/components/charts/NexusCharts';
import { daysFromToday, formatShortDate } from '@/lib/utils';
import type { NexusSprint } from '@/types';

/** Compact sprint panel used on the dashboard and inside project pages. */
export function SprintSummary({ sprint, className }: { sprint: NexusSprint; className?: string }) {
  const progress = Math.round((sprint.completedPoints / Math.max(1, sprint.committedPoints)) * 100);
  const remaining = sprint.committedPoints - sprint.completedPoints;
  const daysLeft = daysFromToday(sprint.endDate) ?? 0;

  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold tracking-tight">{sprint.name}</h2>
            <SprintStateBadge state={sprint.state} />
          </div>
          <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
            {formatShortDate(sprint.startDate)} — {formatShortDate(sprint.endDate)}
          </p>
        </div>
        <Button asChild variant="ghost" size="icon-sm" aria-label="Open the agile workspace">
          <Link to="/agile">
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex gap-2.5 rounded-lg bg-muted/70 p-3">
          <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <p className="text-2xs leading-relaxed text-muted-foreground">{sprint.goal}</p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="nexus-eyebrow">Sprint progress</span>
            <span className="font-mono text-sm font-semibold tabular-nums">{progress}%</span>
          </div>
          <ProgressBar value={progress} tone="primary" label={`${sprint.name} progress`} />
          <p className="text-2xs text-muted-foreground">
            {daysLeft >= 0
              ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} remaining`
              : 'Sprint window closed'}
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2 border-y border-border py-3 text-center">
          <div>
            <dt className="nexus-eyebrow">Committed</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {sprint.committedPoints}
            </dd>
          </div>
          <div>
            <dt className="nexus-eyebrow">Completed</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-success">
              {sprint.completedPoints}
            </dd>
          </div>
          <div>
            <dt className="nexus-eyebrow">Remaining</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{remaining}</dd>
          </div>
        </dl>

        <div className="h-36">
          <BurndownChart data={sprint.burndown} />
        </div>
      </div>
    </Card>
  );
}

export function SprintSummarySkeleton({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-1.5 h-2.5 w-40" />
      </div>
      <div className="space-y-4 p-4">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-2 w-full rounded-full" />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10" />
          ))}
        </div>
        <Skeleton className="h-36 w-full" />
      </div>
    </Card>
  );
}
