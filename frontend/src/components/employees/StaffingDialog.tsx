import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSetCapacity, useSetRate } from '@/hooks/useEmployees';
import { useResourceRoles, useSetPersonRole } from '@/hooks/useResources';
import { env } from '@/config/env';
import { t } from '@/lib/i18n';
import type { EpmEmployee } from '@/services/api/employees';

/**
 * How a person is staffed: hours available per week, and what an hour costs.
 *
 * Separate from `MappingDialog`, mirroring the API split — mapping writes
 * department and team as a unit, and neither of these has any business being
 * restated alongside them. The two fields here share a form because they are
 * one question to whoever answers it, but they are still two writes: capacity
 * and rate are independent attributes with independent endpoints, and only the
 * ones that changed are sent.
 *
 * Zero capacity is a legitimate value — someone who contributes no hours is
 * still a team member — so it is offered rather than treated as clearing the
 * field. An empty rate, by contrast, really does mean "not costed": the Time &
 * Costs report counts those hours and leaves them out of the money, which is
 * different from pricing them at zero.
 */

const MAX_HOURS = 168;
const MAX_RATE = 100_000;
const NO_ROLE = '__none__';

interface StaffingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: EpmEmployee;
}

export function StaffingDialog({ open, onOpenChange, employee }: StaffingDialogProps) {
  const setCapacity = useSetCapacity();
  const setRate = useSetRate();
  const setRole = useSetPersonRole();
  const roles = useResourceRoles();
  const pending = setCapacity.isPending || setRate.isPending || setRole.isPending;

  const [hours, setHours] = useState('');
  const [rate, setRate_] = useState('');
  const [roleId, setRoleId] = useState(NO_ROLE);
  const [problem, setProblem] = useState<string>();

  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setHours(String(employee?.hoursCapacity ?? ''));
    setRate_(employee?.hourlyRate === undefined ? '' : String(employee.hourlyRate));
    setRoleId(employee?.resourceRoleId ?? NO_ROLE);
    setProblem(undefined);
  }, [open, employee?.id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    if (!employee) return;

    const capacityValue = Number(hours);
    if (hours.trim() === '' || Number.isNaN(capacityValue)) {
      return setProblem(t('Enter a number of hours.'));
    }
    if (capacityValue < 0) return setProblem(t('Capacity cannot be negative.'));
    if (capacityValue > MAX_HOURS) {
      return setProblem(t('Capacity cannot exceed {max, number} hours a week.', { max: MAX_HOURS }));
    }

    const rateValue = rate.trim() === '' ? null : Number(rate);
    if (rateValue !== null) {
      if (Number.isNaN(rateValue)) return setProblem(t('Enter an hourly rate, or leave it empty.'));
      if (rateValue < 0) return setProblem(t('An hourly rate cannot be negative.'));
      if (rateValue > MAX_RATE) return setProblem(t('An hourly rate cannot exceed {max, number}.', { max: MAX_RATE }));
    }

    const capacityChanged = capacityValue !== employee.hoursCapacity;
    const rateChanged = rateValue !== (employee.hourlyRate ?? null);
    const nextRole = roleId === NO_ROLE ? null : roleId;
    const roleChanged = nextRole !== (employee.resourceRoleId ?? null);

    if (!capacityChanged && !rateChanged && !roleChanged) return onOpenChange(false);

    try {
      // Sequential rather than parallel: both upsert the same profile row, and
      // two concurrent upserts of one row race each other on the create branch.
      if (capacityChanged) {
        await setCapacity.mutateAsync({ id: employee.id, hoursCapacity: capacityValue });
      }
      if (rateChanged) {
        await setRate.mutateAsync({ id: employee.id, hourlyRate: rateValue });
      }
      if (roleChanged) {
        await setRole.mutateAsync({ personId: employee.id, roleId: nextRole });
      }
      toast.success(t('Staffing saved for {name}', { name: employee.name }));
      onOpenChange(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t('That could not be saved.'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('Staffing for {name}', { name: employee?.name })}</DialogTitle>
            <DialogDescription>
              {t('Weekly availability, and what an hour of this person’s time costs.')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="staffing-hours" required>
                {t('Hours per week')}
              </Label>
              <Input
                id="staffing-hours"
                type="number"
                min={0}
                max={MAX_HOURS}
                step={0.25}
                value={hours}
                autoFocus
                onChange={(event) => setHours(event.target.value)}
              />
              <FieldHint>
                {t(
                  '{min, number} to {max, number}, in quarter-hour steps. Zero means this person contributes no capacity but stays on the team.',
                  { min: 0, max: MAX_HOURS },
                )}
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="staffing-rate">{t('Hourly rate ({currency})', { currency: env.currency })}</Label>
              <Input
                id="staffing-rate"
                type="number"
                min={0}
                max={MAX_RATE}
                step={0.01}
                placeholder={t('Not costed')}
                value={rate}
                onChange={(event) => setRate_(event.target.value)}
              />
              <FieldHint>
                {t(
                  'Used by Time & Costs. Leave it empty and their hours are reported as uncosted rather than as free.',
                )}
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="staffing-role">{t('Role')}</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="staffing-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROLE}>{t('No role')}</SelectItem>
                  {(roles.data ?? []).map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>
                {t('The kind of work they do, for capacity and demand by role.')}{' '}
                {employee ? (
                  <Link to={`/resources?tab=availability&person=${employee.id}`} className="text-foreground underline-offset-2 hover:underline">
                    {t('Work schedule and time off')}
                  </Link>
                ) : null}
              </FieldHint>
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
