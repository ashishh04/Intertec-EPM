import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLogTime } from '@/hooks/useTimeEntries';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { formService } from '@/services';
import { allowedValuesOf, schemaField } from '@/services/api/forms';
import type { ID } from '@/types';

/**
 * Logs time against a work package.
 *
 * Activities come from OpenProject's own time entry form rather than a list
 * held here — an instance defines its own, and a project may narrow them. The
 * form is also what says whether this person may log time at all: EPM has no
 * capability to check, so a refusal arrives from upstream with its reason, and
 * that is what the dialog shows.
 */

interface LogTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workPackageId: ID;
  projectId: ID;
}

const today = () => new Date().toISOString().slice(0, 10);

export function LogTimeDialog({
  open,
  onOpenChange,
  workPackageId,
  projectId,
}: LogTimeDialogProps) {
  const log = useLogTime();

  const [hours, setHours] = useState('');
  const [spentOn, setSpentOn] = useState(today);
  const [comment, setComment] = useState('');
  const [activityId, setActivityId] = useState<string>();
  const [error, setError] = useState<string>();

  // The form is asked for the activities this project allows, and doubles as
  // the permission check: a 403 here means OpenProject will refuse the write.
  const form = useSchemaForm(
    (payload) => formService.timeEntryForm({ workPackageId, projectId }, payload),
    { enabled: open },
  );

  const activities = (() => {
    const field = schemaField(form.form, 'activity');
    return field ? (allowedValuesOf(field) ?? []) : [];
  })();

  useEffect(() => {
    if (!open) return;
    setHours('');
    setSpentOn(today());
    setComment('');
    setActivityId(undefined);
    setError(undefined);
  }, [open]);

  // Default to whatever the instance offers first, once it has answered.
  useEffect(() => {
    if (!activityId && activities.length > 0) setActivityId(activities[0].id);
  }, [activityId, activities]);

  const submit = () => {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the hours worked, e.g. 1.5.');
      return;
    }

    log.mutate(
      {
        workPackageId,
        projectId,
        hours: value,
        spentOn,
        comment: comment.trim() || undefined,
        activityId,
      },
      {
        onSuccess: (entry) => {
          toast.success('Time logged', { description: `${entry.hours}h on ${entry.spentOn}` });
          onOpenChange(false);
        },
        // OpenProject's sentence, not a generic one: "You are not allowed to
        // log time on this project" is the whole answer.
        onError: (failure) =>
          setError(failure instanceof Error ? failure.message : 'The entry was refused.'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log time</DialogTitle>
          <DialogDescription>
            Recorded against this work package and its project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="time-hours" required>
                Hours
              </Label>
              <Input
                id="time-hours"
                inputMode="decimal"
                placeholder="1.5"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
              <FieldHint>Quarters are fine.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="time-date" required>
                Date
              </Label>
              <Input
                id="time-date"
                type="date"
                value={spentOn}
                onChange={(event) => setSpentOn(event.target.value)}
              />
            </div>
          </div>

          {activities.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="time-activity">Activity</Label>
              <Select value={activityId} onValueChange={setActivityId}>
                <SelectTrigger id="time-activity">
                  <SelectValue placeholder="Select an activity" />
                </SelectTrigger>
                <SelectContent>
                  {activities.map((activity) => (
                    <SelectItem key={activity.id} value={activity.id}>
                      {activity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="time-comment">Comment</Label>
            <Textarea
              id="time-comment"
              rows={3}
              placeholder="What was done in this time."
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </div>

          {error ? <FieldError>{error}</FieldError> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={log.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={log.isPending}>
            Log time
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
