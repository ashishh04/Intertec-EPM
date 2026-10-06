import { useState } from 'react';
import { History, Pencil, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { HealthIndicator } from '@/components/common/StatusBadge';
import { HealthOverrideDialog } from '@/components/projects/HealthOverrideDialog';
import { ProjectJournal } from '@/components/projects/ProjectJournal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useRecalculateHealth } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { HEALTH_CRITERIA_META, HEALTH_META, formatHealthValue } from '@/lib/domain';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmProject } from '@/types';

/**
 * A project's health, and how it was arrived at (BR-204 – BR-206).
 *
 * Every criterion shows the figure it measured and the rule it met, so the
 * colour can be checked rather than taken on trust. An override is shown with
 * its reason, its author and the calculated value beside it — a pin never
 * hides the signal underneath it.
 */
export function ProjectHealthCard({ project }: { project: EpmProject }) {
  const { can, canInProject } = useAuth();
  const canOverride = can('health:manage');
  const canRecalculate = canOverride || canInProject(project.id, 'project:edit');

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const recalculate = useRecalculateHealth();
  const users = useUserMap();

  const detail = project.healthDetail;
  const override = project.healthOverride;
  const pinnedOverall = override?.levels.overall;
  const setBy = override ? users.get(override.setBy) : undefined;
  const neverCalculated = !detail || Date.parse(detail.calculatedAt) <= 0;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          <div className="flex items-center gap-1">
            {canRecalculate ? (
              <InfoTooltip label="Recalculate now">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Recalculate health now"
                  disabled={recalculate.isPending}
                  onClick={() =>
                    recalculate.mutate(project.id, {
                      onSuccess: () => toast.success('Health recalculated'),
                      onError: (error) =>
                        toast.error('Health could not be recalculated', {
                          description: error instanceof Error ? error.message : undefined,
                        }),
                    })
                  }
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', recalculate.isPending && 'animate-spin')} />
                </Button>
              </InfoTooltip>
            ) : null}
            {canOverride ? (
              <Button size="sm" variant="ghost" onClick={() => setOverrideOpen(true)}>
                <Pencil className="h-3.5 w-3.5" />
                Override
              </Button>
            ) : null}
          </div>
        }
      >
        <CardTitle>Project health</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        {/* Overall, with why. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              Overall
              {pinnedOverall ? (
                <Badge tone="accent" className="text-2xs">
                  Overridden
                </Badge>
              ) : null}
            </p>
            {/* The explanation is of the calculated value. Under a pinned
                overall it is labelled as such, so it never reads as the
                reason for the level shown beside it. */}
            <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
              {pinnedOverall ? (
                <span className="font-medium text-foreground">
                  Calculated {HEALTH_META[project.healthCalculated.overall].label.toLowerCase()}.{' '}
                </span>
              ) : null}
              {detail?.explanation}
            </p>
          </div>
          <HealthIndicator level={project.health.overall} className="shrink-0" />
        </div>

        {override ? (
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-2.5">
            <p className="text-2xs font-medium text-foreground">Why it is overridden</p>
            <p className="mt-0.5 text-xs leading-relaxed">{override.reason}</p>
            <p className="mt-1 text-2xs text-muted-foreground">
              {override.setBy === 'unknown'
                ? 'Carried over from before overrides needed a reason.'
                : `${setBy?.name ?? 'Someone no longer listed'}, ${formatDateTime(override.setAt)}`}
            </p>
          </div>
        ) : null}

        <ul className="space-y-3 border-t border-border pt-3">
          {HEALTH_CRITERIA_META.map((meta) => {
            const result = detail?.criteria.find((criterion) => criterion.criterion === meta.key);
            // Switched off in the rules: neither measured nor shown.
            if (!result && !neverCalculated) return null;
            const pinned = override?.levels[meta.key];

            return (
              <li key={meta.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                    {meta.label}
                    {result && result.value !== null ? (
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatHealthValue(result.value, result.unit)}
                      </span>
                    ) : null}
                    {pinned ? (
                      <Badge tone="accent" className="text-2xs">
                        Overridden
                      </Badge>
                    ) : null}
                    {result?.weight === 0 ? (
                      <Badge tone="neutral" className="text-2xs">
                        Not counted
                      </Badge>
                    ) : null}
                  </p>
                  {/* The reason names the figures the rule used, so the value
                      can be checked rather than taken on trust. */}
                  <p className="text-2xs leading-relaxed text-muted-foreground">{result?.reason ?? meta.hint}</p>
                  {pinned ? (
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      Calculated:{' '}
                      {project.healthCalculated[meta.key]
                        ? HEALTH_META[project.healthCalculated[meta.key]!].label
                        : 'Not assessed'}
                    </p>
                  ) : null}
                </div>
                <HealthIndicator level={project.health[meta.key]} className="shrink-0" />
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-2xs text-muted-foreground">
          <span>
            {neverCalculated ? (
              'Not calculated yet'
            ) : (
              <InfoTooltip label={formatDateTime(detail.calculatedAt)}>
                <span tabIndex={0}>
                  Calculated {formatRelative(detail.calculatedAt)}
                  {detail.ruleVersion > 0 ? ` · rules v${detail.ruleVersion}` : ' · default rules'}
                </span>
              </InfoTooltip>
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            <History className="h-3.5 w-3.5" />
            History
          </Button>
        </div>
      </CardContent>

      {canOverride ? (
        <HealthOverrideDialog open={overrideOpen} onOpenChange={setOverrideOpen} project={project} />
      ) : null}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Health history</DialogTitle>
            <DialogDescription>
              Every calculation that moved, and every override, with who and why. Recorded as it
              happened and never edited.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <ProjectJournal projectId={project.id} action="health." limit={100} />
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
