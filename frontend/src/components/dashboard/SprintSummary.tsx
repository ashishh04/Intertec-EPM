import { Link } from 'react-router-dom';
import { ArrowRight, Flag } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SprintStateBadge } from '@/components/common/StatusBadge';
import { BurndownChart } from '@/components/charts/EpmCharts';
import { cn, daysFromToday, formatNumber, formatPercent, formatShortDate, pluralize } from '@/lib/utils';
import type { EpmSprint } from '@/types';

/** Compact sprint panel used on the dashboard and inside project pages. */
export function SprintSummary({ sprint, className }: { sprint: EpmSprint; className?: string }) {
  const progress = Math.round((sprint.completedPoints / Math.max(1, sprint.committedPoints)) * 100);
  const remaining = sprint.committedPoints - sprint.completedPoints;
  const daysLeft = daysFromToday(sprint.endDate) ?? 0;

  return (
    <Card className={className}>
      <CardHeader
        variant="compact"
        actions={
          <Button asChild variant="ghost" size="icon-sm" aria-label="Open the agile workspace">
            <Link to="/agile">
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate">{sprint.name}</CardTitle>
          <SprintStateBadge state={sprint.state} />
        </div>
        <p className="font-mono text-2xs tabular-nums text-muted-foreground">
          {formatShortDate(sprint.startDate)} — {formatShortDate(sprint.endDate)}
        </p>
      </CardHeader>

      <div className="space-y-4 p-4">
        <div className="flex gap-2.5 rounded-lg bg-muted/70 p-3">
          <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {sprint.goal || 'No sprint goal has been set.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="epm-eyebrow">Sprint progress</span>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {formatPercent(progress)}
            </span>
          </div>
          <ProgressBar value={progress} tone="primary" label={`${sprint.name} progress`} />
          <p className="text-2xs text-muted-foreground">
            {daysLeft >= 0
              ? `${formatNumber(daysLeft)} ${pluralize(daysLeft, 'day')} remaining`
              : 'Sprint window closed'}
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2 border-y border-border py-3 text-center">
          <div>
            <dt className="epm-eyebrow">Committed</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {formatNumber(sprint.committedPoints)}
            </dd>
          </div>
          <div>
            <dt className="epm-eyebrow">Completed</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-success-strong">
              {formatNumber(sprint.completedPoints)}
            </dd>
          </div>
          <div>
            <dt className="epm-eyebrow">Remaining</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {formatNumber(remaining)}
            </dd>
          </div>
        </dl>

        <div className="h-36">
          <BurndownChart data={sprint.burndown} />
        </div>
      </div>
    </Card>
  );
}

/**
 * Shown when no sprint is running. Being between sprints is normal, so this is
 * a quiet statement of fact rather than an error — and crucially it is not the
 * skeleton, which previously stayed on screen forever in this case.
 */
export function SprintSummaryEmpty({ className }: { className?: string }) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader variant="compact">
        <CardTitle>Sprint</CardTitle>
      </CardHeader>
      <EmptyState
        size="inline"
        icon={Flag}
        title="No active sprint"
        description="Start a sprint in the agile workspace to track burndown and committed points here."
        className="flex-1"
      />
      <div className="p-4 pt-0">
        <Button asChild variant="secondary" size="sm" className="w-full">
          <Link to="/agile">
            Open agile workspace
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

export function SprintSummarySkeleton({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader variant="compact">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-1 h-2.5 w-40" />
      </CardHeader>
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
