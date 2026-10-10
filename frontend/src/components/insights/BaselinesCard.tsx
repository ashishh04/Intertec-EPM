import { useState } from 'react';
import { toast } from 'sonner';
import { Flag } from 'lucide-react';

import { PromptDialog } from '@/components/common/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useBaselines, useSetBaseline } from '@/hooks/useEarnedValue';
import { useUserMap } from '@/hooks/useUsers';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { ID } from '@/types';
import { formatMeasure } from './format';

/**
 * A project's baselines, on its Earned value dashboard (BR-301): what planned
 * value is measured against, every baseline set and why, and — for whoever
 * may edit the project — setting a new one. A baseline is the plan as it
 * stands, priced and frozen; it is never changed afterwards.
 */
export function BaselinesCard({ projectId }: { projectId: ID }) {
  const baselines = useBaselines(projectId);
  const setBaseline = useSetBaseline(projectId);
  const { canInProject } = useAuth();
  const users = useUserMap();
  const [open, setOpen] = useState(false);
  const canSet = canInProject(projectId, 'project:edit');
  const list = baselines.data ?? [];

  const submit = (reason: string) =>
    setBaseline.mutate(reason, {
      onSuccess: (baseline) => {
        setOpen(false);
        toast.success(`Baseline ${baseline.number} set`, {
          description: `${formatNumber(baseline.items)} work packages, budget at completion ${formatMeasure(baseline.bac, 'money')}.`,
        });
      },
      onError: (error) => toast.error('The baseline was not set', { description: error instanceof Error ? error.message : undefined }),
    });

  return (
    <Card data-testid="evm-baselines">
      <CardHeader variant="compact">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Baselines</CardTitle>
            <CardDescription>
              Planned value is measured against the last baseline set by each date — or, before the first, against the first.
              With none, it is measured against the plan as it stands, and moves whenever the plan does.
            </CardDescription>
          </div>
          {canSet ? (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>
              <Flag className="h-3.5 w-3.5" />
              Set baseline
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {baselines.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : list.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No baseline yet: the figures above are measured against the current plan.
            {canSet ? ' Set one to fix what this project is measured against.' : ''}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((baseline, index) => (
              <li key={baseline.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-xs first:pt-0 last:pb-0">
                <span className="font-medium text-foreground">Baseline {baseline.number}</span>
                {index === 0 ? (
                  <Badge tone="primary" size="sm">
                    In force
                  </Badge>
                ) : null}
                <span className="text-muted-foreground">
                  Set {formatDateTime(baseline.setAt)} by {users.get(baseline.setBy)?.name ?? 'someone'}
                </span>
                <span className="text-muted-foreground">
                  BAC {formatMeasure(baseline.bac, 'money')} · {formatNumber(baseline.items)} work packages
                  {baseline.unpriced ? ` · ${formatNumber(baseline.unpriced)} with no rate` : ''}
                  {baseline.undated ? ` · ${formatNumber(baseline.undated)} undated` : ''}
                </span>
                {baseline.reason ? <span className="basis-full text-muted-foreground">“{baseline.reason}”</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <PromptDialog
        open={open}
        onOpenChange={setOpen}
        title="Set a baseline"
        description="Freezes every work package's estimate, priced at its assignee's hourly rate, and its planned dates, as they stand now. It cannot be changed afterwards: a new plan is a new baseline. It is journalled."
        label="Why now"
        placeholder="e.g. Plan approved at the steering committee on 12 October"
        confirmLabel="Set baseline"
        pending={setBaseline.isPending}
        onSubmit={submit}
      />
    </Card>
  );
}
