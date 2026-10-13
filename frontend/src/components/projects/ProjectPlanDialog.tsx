import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { env } from '@/config/env';
import { useUpdateProjectPlan } from '@/hooks/useProjects';
import { t } from '@/lib/i18n';
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
  const [billable, setBillable] = useState('default');
  const [ownerApproves, setOwnerApproves] = useState('yes');
  const [timezone, setTimezone] = useState<string>();
  const zones = useMemo(() => ((Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? []).map((zone) => ({ id: zone, name: zone })), []);
  const [problem, setProblem] = useState<string>();

  // Keyed on the id for the same reason as the override dialog: a refetch must
  // not reset the form under the person editing it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setStart(project.startDate?.slice(0, 10) ?? '');
    setFinish(project.dueDate?.slice(0, 10) ?? '');
    setBudget(project.budgetTotal > 0 ? String(project.budgetTotal) : '');
    setBillable(project.billable === true ? 'yes' : project.billable === false ? 'no' : 'default');
    setOwnerApproves(project.timesheetApproval === false ? 'no' : 'yes');
    setTimezone(project.timezone ?? undefined);
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
      billable: billable === 'yes' ? true : billable === 'no' ? false : null,
      timesheetApproval: ownerApproves === 'no' ? false : null,
      timezone: timezone ?? null,
    };

    updatePlan.mutate(
      { id: project.id, plan },
      {
        onSuccess: () => {
          toast.success(t('Plan saved'), { description: t('Health has been recalculated against it.') });
          onOpenChange(false);
        },
        onError: (error) => setProblem(error instanceof Error ? error.message : t('That could not be saved.')),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Plan and budget')}</DialogTitle>
          <DialogDescription>
            {t('The baseline this project\'s health is measured against. Leave a field empty to clear it.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-start">{t('Planned start')}</Label>
              <Input id="plan-start" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-finish">{t('Planned finish')}</Label>
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
            <FieldError>{t('The planned finish cannot be before the planned start.')}</FieldError>
          ) : (
            <FieldHint>
              {t(
                'Schedule variance is measured from the planned finish; the budget is phased evenly between the two dates.',
              )}
            </FieldHint>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="plan-budget">{t('Budget ({currency})', { currency: env.currency })}</Label>
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
              <FieldError>{t('A budget is a positive amount, or empty for none.')}</FieldError>
            ) : (
              <FieldHint>
                {t(
                  'Spend is calculated from logged time at each person\'s hourly rate, so only the budget is entered here.',
                )}
              </FieldHint>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-billable">{t('Time logged here')}</Label>
            <Select value={billable} onValueChange={setBillable}>
              <SelectTrigger id="plan-billable">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('As the resource rules default')}</SelectItem>
                <SelectItem value="yes">{t('Is billable')}</SelectItem>
                <SelectItem value="no">{t('Is not billable')}</SelectItem>
              </SelectContent>
            </Select>
            <FieldHint>{t('Billable utilisation counts the time logged on billable projects, less any activity the resource rules call non-billable.')}</FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-timesheets">{t('Timesheets with time here')}</Label>
            <Select value={ownerApproves} onValueChange={setOwnerApproves}>
              <SelectTrigger id="plan-timesheets">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">{t('Are approved by the project owner too')}</SelectItem>
                <SelectItem value="no">{t('Are approved by the line manager alone')}</SelectItem>
              </SelectContent>
            </Select>
            <FieldHint>{t('After a person’s line manager, the owners of the projects their time is on approve their timesheet.')}</FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-timezone">{t('Timezone')}</Label>
            <ComboSelect id="plan-timezone" label={t('Timezone')} options={zones} value={timezone} onChange={setTimezone} clearable placeholder={t('The instance default')} />
            <FieldHint>{t('The project’s dates are calendar days in its timezone: everyone sees the same day, wherever they are.')}</FieldHint>
          </div>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={updatePlan.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} loading={updatePlan.isPending} disabled={finishBeforeStart || budgetInvalid}>
            {t('Save plan')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
