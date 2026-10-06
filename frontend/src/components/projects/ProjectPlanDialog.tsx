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
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { env } from '@/config/env';
import { useUpdateProjectPlan } from '@/hooks/useProjects';
import type { EpmProject, ProjectPlanInput } from '@/types';

/**
 * A project's plan: planned start, planned finish and budget.
 *
 * EPM's own fields — an OpenProject project has no dates and no budget — and
 * the baseline health measures against: schedule variance from the planned
 * finish, budget variance from the budget phased across the planned dates.
 * Saving recalculates health before answering, and every change is journalled.
 */

interface ProjectPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: EpmProject;
}

export function ProjectPlanDialog({ open, onOpenChange, project }: ProjectPlanDialogProps) {
  const updatePlan = useUpdateProjectPlan();

  const [start, setStart] = useState('');
  const [finish, setFinish] = useState('');
  const [budget, setBudget] = useState('');
  const [problem, setProblem] = useState<string>();

  // Keyed on the id for the same reason as the override dialog: a refetch must
  // not reset the form under the person editing it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setStart(project.startDate?.slice(0, 10) ?? '');
    setFinish(project.dueDate?.slice(0, 10) ?? '');
    setBudget(project.budgetTotal > 0 ? String(project.budgetTotal) : '');
    setProblem(undefined);
  }, [open, project.id]);

  const budgetValue = budget.trim() === '' ? null : Number(budget);
  const finishBeforeStart = Boolean(start && finish && finish < start);
  const budgetInvalid = budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue < 0);

  const save = () => {
    setProblem(undefined);
    if (finishBeforeStart || budgetInvalid) return;

    const plan: ProjectPlanInput = {
      plannedStart: start || null,
      plannedFinish: finish || null,
      budgetTotal: budgetValue,
    };

    updatePlan.mutate(
      { id: project.id, plan },
      {
        onSuccess: () => {
          toast.success('Plan saved', { description: 'Health has been recalculated against it.' });
          onOpenChange(false);
        },
        onError: (error) => setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Plan and budget</DialogTitle>
          <DialogDescription>
            The baseline this project&apos;s health is measured against. Leave a field empty to
            clear it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-start">Planned start</Label>
              <Input id="plan-start" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-finish">Planned finish</Label>
              <Input
                id="plan-finish"
                type="date"
                value={finish}
                min={start || undefined}
                onChange={(event) => setFinish(event.target.value)}
                invalid={finishBeforeStart}
              />
            </div>
          </div>
          {finishBeforeStart ? (
            <FieldError>The planned finish cannot be before the planned start.</FieldError>
          ) : (
            <FieldHint>
              Schedule variance is measured from the planned finish; the budget is phased evenly
              between the two dates.
            </FieldHint>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="plan-budget">Budget ({env.currency})</Label>
            <Input
              id="plan-budget"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              invalid={budgetInvalid}
            />
            {budgetInvalid ? (
              <FieldError>A budget is a positive amount, or empty for none.</FieldError>
            ) : (
              <FieldHint>
                Spend is calculated from logged time at each person&apos;s hourly rate, so only the
                budget is entered here.
              </FieldHint>
            )}
          </div>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={updatePlan.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={updatePlan.isPending} disabled={finishBeforeStart || budgetInvalid}>
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
