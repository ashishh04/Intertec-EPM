import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSetHealthOverride } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { HEALTH_CRITERIA_META, HEALTH_META } from '@/lib/domain';
import { formatDateTime } from '@/lib/utils';
import type { EpmProject, HealthDimension, HealthLevel, HealthOverride } from '@/types';

/**
 * Override a project's calculated health, with a reason (BR-206).
 *
 * Each row shows what the rules calculated next to what is pinned, so the
 * person overruling it can see exactly what they are overruling. "Calculated"
 * clears that row rather than pinning it to the same value — those are
 * different states, and only one of them keeps following the data.
 *
 * The reason is required to set or change an override. It is kept with it,
 * shown wherever the overridden value is, and written to the project journal.
 */

const CALCULATED = '__calculated__';
const MIN_REASON = 10;

const ROWS: { key: HealthDimension; label: string }[] = [
  { key: 'overall', label: 'Overall' },
  ...HEALTH_CRITERIA_META.map(({ key, label }) => ({ key, label })),
];

const LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];

interface HealthOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: EpmProject;
}

export function HealthOverrideDialog({ open, onOpenChange, project }: HealthOverrideDialogProps) {
  const setOverride = useSetHealthOverride();
  const users = useUserMap();
  const current = project.healthOverride;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string>();
  const [touched, setTouched] = useState(false);

  // Keyed on the project's id, not the object. `project` is a fresh object on
  // every refetch, and depending on it meant a background refetch reset the
  // form under the user and discarded whatever they had just chosen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const { key } of ROWS) initial[key] = current?.levels[key] ?? CALCULATED;
    setDraft(initial);
    setReason('');
    setProblem(undefined);
    setTouched(false);
  }, [open, project.id]);

  const levels: HealthOverride = {};
  for (const { key } of ROWS) {
    const value = draft[key];
    if (value && value !== CALCULATED) levels[key] = value as HealthLevel;
  }
  const pinsSomething = Object.keys(levels).length > 0;
  const reasonShort = reason.trim().length < MIN_REASON;

  const submit = (clear: boolean) => {
    setProblem(undefined);
    setTouched(true);
    if (!clear && pinsSomething && reasonShort) return;

    setOverride.mutate(
      { id: project.id, levels: clear ? {} : levels, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(clear || !pinsSomething ? 'Override cleared' : 'Override saved');
          onOpenChange(false);
        },
        onError: (error) => setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  const setBy = current ? users.get(current.setBy) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Override health</DialogTitle>
          <DialogDescription>
            Pin a level where the calculated value is wrong. Anything left on
            &ldquo;calculated&rdquo; keeps following the data, and the calculated value stays
            visible beside every override.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {current ? (
            <Alert tone="primary" title="An override is in force">
              {current.reason}
              <span className="mt-1 block text-2xs text-muted-foreground">
                {current.setBy === 'unknown'
                  ? 'Carried over from before overrides needed a reason.'
                  : `Set by ${setBy?.name ?? 'someone no longer listed'}, ${formatDateTime(current.setAt)}.`}
              </span>
            </Alert>
          ) : null}

          <div className="space-y-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_9rem] items-center gap-3 text-2xs font-medium text-muted-foreground">
              <span>Criterion</span>
              <span>Calculated</span>
              <span>Override</span>
            </div>
            {ROWS.map((row) => (
              <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_7rem_9rem] items-center gap-3">
                <Label htmlFor={`health-${row.key}`} className={row.key === 'overall' ? 'font-semibold' : undefined}>
                  {row.label}
                </Label>
                <HealthIndicator level={project.healthCalculated[row.key]} />
                <Select
                  value={draft[row.key] ?? CALCULATED}
                  onValueChange={(value) => setDraft((was) => ({ ...was, [row.key]: value }))}
                >
                  <SelectTrigger id={`health-${row.key}`} aria-label={`Override ${row.label}`} className="h-8 text-xs">
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="health-reason" required={pinsSomething}>
              Reason
            </Label>
            <Textarea
              id="health-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What do you know that the data does not? e.g. the change request adding budget was approved on 1 October and has not been loaded yet."
              rows={3}
              maxLength={2000}
              invalid={touched && pinsSomething && reasonShort}
            />
            {touched && pinsSomething && reasonShort ? (
              <FieldError>Say why the calculated health is wrong, in at least {MIN_REASON} characters.</FieldError>
            ) : (
              <FieldHint>
                Kept with the override, shown wherever the overridden value is, and recorded in the
                project journal with your name.
              </FieldHint>
            )}
          </div>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {current ? (
              <Button variant="secondary" onClick={() => submit(true)} disabled={setOverride.isPending}>
                Clear override
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={setOverride.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => submit(false)}
              disabled={!pinsSomething && !current}
              loading={setOverride.isPending}
            >
              {pinsSomething || !current ? 'Save override' : 'Clear override'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
