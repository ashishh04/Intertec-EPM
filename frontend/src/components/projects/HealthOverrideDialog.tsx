import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HealthIndicator } from '@/components/common/StatusBadge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSetHealthOverride } from '@/hooks/useProjects';
import { HEALTH_META } from '@/lib/domain';
import type { EpmProject, HealthDimension, HealthLevel } from '@/types';

/**
 * Pin health dimensions the calculated rules get wrong.
 *
 * Each row shows what the rules produced next to what is pinned, so the person
 * setting an override can see exactly what they are overruling. "Calculated"
 * clears that dimension rather than pinning it to the same value — those are
 * different states, and only one of them keeps tracking the data.
 */

const CALCULATED = '__calculated__';

const DIMENSIONS: { key: HealthDimension; label: string }[] = [
  { key: 'scope', label: 'Scope' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'resources', label: 'Resources' },
  { key: 'budget', label: 'Budget' },
  { key: 'overall', label: 'Overall' },
];

const LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];

interface HealthOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: EpmProject;
}

export function HealthOverrideDialog({ open, onOpenChange, project }: HealthOverrideDialogProps) {
  const setOverride = useSetHealthOverride();

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const current: Record<string, string> = {};
    for (const { key } of DIMENSIONS) current[key] = project.healthOverride?.[key] ?? CALCULATED;
    setDraft(current);
    setProblem(undefined);
  }, [open, project]);

  const save = () => {
    setProblem(undefined);

    // Only pinned dimensions are sent. Everything else is absent, which is how
    // the backend is told to clear it.
    const body: Partial<Record<HealthDimension, HealthLevel>> = {};
    for (const { key } of DIMENSIONS) {
      const value = draft[key];
      if (value && value !== CALCULATED) body[key] = value as HealthLevel;
    }

    setOverride.mutate(
      { id: project.id, override: body },
      {
        onSuccess: () => {
          toast.success(
            Object.keys(body).length === 0 ? 'Health overrides cleared' : 'Health override saved',
          );
          onOpenChange(false);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  const clearAll = () => {
    const cleared: Record<string, string> = {};
    for (const { key } of DIMENSIONS) cleared[key] = CALCULATED;
    setDraft(cleared);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Override health</DialogTitle>
          <DialogDescription>
            Pin a dimension where the calculated value is wrong. Anything left on
            &ldquo;calculated&rdquo; keeps following the data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {DIMENSIONS.map((dimension) => (
            <div key={dimension.key} className="flex items-center gap-3">
              <Label htmlFor={`health-${dimension.key}`} className="w-24 shrink-0">
                {dimension.label}
              </Label>

              {/* What the rules said, so the person overruling it can see it. */}
              <span className="w-28 shrink-0">
                <HealthIndicator
                  level={project.healthCalculated[dimension.key]}
                  label={HEALTH_META[project.healthCalculated[dimension.key]].label}
                />
              </span>

              <Select
                value={draft[dimension.key] ?? CALCULATED}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, [dimension.key]: value }))
                }
              >
                <SelectTrigger
                  id={`health-${dimension.key}`}
                  aria-label={`Override ${dimension.label}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CALCULATED}>Calculated</SelectItem>
                  {LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {HEALTH_META[level].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          <p className="text-2xs text-muted-foreground">
            Overall follows the worst of the four dimensions unless it is pinned itself.
          </p>

          {problem ? (
            <p role="alert" className="text-xs text-danger">
              {problem}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={clearAll}>
            Clear all
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={setOverride.isPending} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
