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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSetCapacity } from '@/hooks/useEmployees';
import type { EpmEmployee } from '@/services/api/employees';

/**
 * Set how many hours a week a person is available for.
 *
 * Separate from `MappingDialog`, mirroring the API split: mapping writes
 * department and team as a unit, and capacity is an independent attribute that
 * has no business being restated alongside them.
 *
 * Zero is a legitimate value — someone who contributes no hours is still a team
 * member — so it is offered rather than treated as clearing the field.
 */

const MAX_HOURS = 168;

interface CapacityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: EpmEmployee;
}

export function CapacityDialog({ open, onOpenChange, employee }: CapacityDialogProps) {
  const setCapacity = useSetCapacity();

  const [hours, setHours] = useState('');
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setHours(String(employee?.hoursCapacity ?? ''));
    setProblem(undefined);
  }, [open, employee]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    if (!employee) return;

    const value = Number(hours);
    if (hours.trim() === '' || Number.isNaN(value)) {
      return setProblem('Enter a number of hours.');
    }
    if (value < 0) return setProblem('Capacity cannot be negative.');
    if (value > MAX_HOURS) return setProblem(`Capacity cannot exceed ${MAX_HOURS} hours a week.`);

    setCapacity.mutate(
      { id: employee.id, hoursCapacity: value },
      {
        onSuccess: (updated) => {
          toast.success(`${updated.name} set to ${updated.hoursCapacity} h/week`);
          onOpenChange(false);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Capacity for {employee?.name}</DialogTitle>
            <DialogDescription>
              Hours available per week. Used for team and department totals.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="capacity-hours" required>
                Hours per week
              </Label>
              <Input
                id="capacity-hours"
                type="number"
                min={0}
                max={MAX_HOURS}
                step={0.25}
                value={hours}
                autoFocus
                onChange={(event) => setHours(event.target.value)}
              />
              <p className="text-2xs text-muted-foreground">
                0 to {MAX_HOURS}, in quarter-hour steps. Zero means this person contributes no
                capacity but stays on the team.
              </p>
            </div>

            {problem ? (
              <p role="alert" className="text-xs text-danger">
                {problem}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={setCapacity.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
