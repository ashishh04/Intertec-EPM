import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
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
import { useLogTime, useUpdateTimeEntry } from '@/hooks/useTimeEntries';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { formService } from '@/services';
import { allowedValuesOf, schemaField } from '@/services/api/forms';
import type { EpmTimeEntry, ID } from '@/types';

/**
 * Creates or edits a time entry from the timesheet.
 *
 * This is the standalone form, as opposed to `tasks/LogTimeDialog`, which logs
 * against a work package already on screen and therefore needs no pickers. Here
 * the entry has no context: the person is filling in a week, so the project is
 * theirs to choose and the task is optional — time logged to a project with no
 * work package attached is legitimate in OpenProject and is how overheads are
 * usually recorded.
 *
 * Activities come from OpenProject's own time entry form rather than a list held
 * here, and that call doubles as the permission check: EPM has no capability for
 * logging time, so a refusal arrives from upstream carrying its own reason.
 */

interface TimeEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing entry. Its project and task are then fixed. */
  entry?: EpmTimeEntry;
  /** Pre-filled date for a new entry, from the day column that was clicked. */
  spentOn?: string;
  /** Pre-selected project for a new entry, e.g. from a project's own page. */
  projectId?: ID;
}

const today = () => new Date().toISOString().slice(0, 10);

/** How many of a project's work packages the task picker offers. */
const TASK_OPTIONS = 100;

export function TimeEntryDialog({
  open,
  onOpenChange,
  entry,
  spentOn: initialDate,
  projectId: initialProject,
}: TimeEntryDialogProps) {
  const editing = Boolean(entry);
  const log = useLogTime();
  const update = useUpdateTimeEntry();
  const pending = log.isPending || update.isPending;

  const [projectId, setProjectId] = useState<string | undefined>();
  const [workPackageId, setWorkPackageId] = useState<string | undefined>();
  const [hours, setHours] = useState('');
  const [spentOn, setSpentOn] = useState(today);
  const [comment, setComment] = useState('');
  const [activityId, setActivityId] = useState<string>();
  const [error, setError] = useState<string>();

  // Seeded each time the dialog opens, from the entry being edited or from
  // whatever the caller pre-filled. Not on every render: the person is typing
  // into these fields.
  useEffect(() => {
    if (!open) return;
    setProjectId(entry?.projectId ?? initialProject);
    setWorkPackageId(entry?.workPackageId);
    setHours(entry ? String(entry.hours) : '');
    setSpentOn(entry?.spentOn ?? initialDate ?? today());
    setComment(entry?.comment ?? '');
    setActivityId(entry?.activityId);
    setError(undefined);
  }, [open, entry, initialDate, initialProject]);

  const projectsQuery = useProjects();
  // Only once a project is chosen, and only its open work packages: logging
  // time against something closed is possible upstream but is not what the
  // picker is for, and 100 open items is already more than anyone scrolls.
  const tasksQuery = useTasks(
    { projectId, bucket: 'open', pageSize: TASK_OPTIONS },
    { enabled: open && Boolean(projectId) && !editing },
  );

  /*
   * The activities this project allows.
   *
   * Asked for with the scope the entry will actually be written at, because an
   * instance may narrow the list per project — reading it once globally would
   * offer activities the write then refuses.
   */
  const form = useSchemaForm(
    (payload) =>
      formService.timeEntryForm(
        workPackageId ? { workPackageId, projectId } : { projectId },
        payload,
      ),
    { enabled: open && Boolean(projectId || workPackageId) },
  );

  const activities = useMemo(() => {
    const field = schemaField(form.form, 'activity');
    return field ? (allowedValuesOf(field) ?? []) : [];
  }, [form.form]);

  /*
   * The form call doubles as the permission check, so a refusal is known before
   * the person types anything. Shown as soon as it is known rather than on
   * submit: filling in hours, a date and a comment only to be told you were
   * never allowed is the worst order to learn it in.
   */
  const refused = /^you are not authorized/i.test(form.error?.message ?? '');

  // Default to whatever the instance offers first, once it has answered. An
  // entry being edited keeps its own activity even if it is no longer offered.
  useEffect(() => {
    if (activityId || activities.length === 0) return;
    setActivityId(activities[0]!.id);
  }, [activityId, activities]);

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  const taskOptions = useMemo(
    () =>
      (tasksQuery.data?.items ?? []).map((task) => ({
        id: task.id,
        name: task.subject,
        hint: task.key,
      })),
    [tasksQuery.data],
  );

  const submit = () => {
    setError(undefined);

    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the hours worked, e.g. 1.5.');
      return;
    }
    if (!projectId && !workPackageId) {
      setError('Choose the project the time was spent on.');
      return;
    }

    const body = {
      hours: value,
      spentOn,
      comment: comment.trim() || undefined,
      activityId,
    };

    const done = (message: string) => {
      toast.success(message, { description: `${value}h on ${spentOn}` });
      onOpenChange(false);
    };
    // Upstream's sentence, not a generic one: "You are not allowed to log time
    // on this project" is the whole answer and the reader needs it verbatim.
    const failed = (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'The entry was refused.');

    if (entry) {
      // Project and work package are deliberately not sent on an edit. They are
      // fixed for the life of the entry here, and restating them would let a
      // stale picker move somebody's time to another project by accident.
      update.mutate(
        { id: entry.id, ...body },
        { onSuccess: () => done('Entry updated'), onError: failed },
      );
      return;
    }

    log.mutate(
      { ...body, projectId, workPackageId },
      { onSuccess: () => done('Time logged'), onError: failed },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit entry' : 'Log time'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'The project and task this was logged against cannot be changed.'
              : 'Against a task, or against a project for work with no task of its own.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {editing ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-2xs text-muted-foreground">
                {entry?.projectName ?? 'Project'}
              </p>
              <p className="truncate text-xs font-medium">
                {entry?.workPackageSubject ?? 'Logged to the project'}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="time-project" required>
                  Project
                </Label>
                <ComboSelect
                  id="time-project"
                  label="Project"
                  options={projectOptions}
                  value={projectId}
                  loading={projectsQuery.isLoading}
                  emptyLabel="No projects match"
                  placeholder="Choose a project"
                  onChange={(next) => {
                    setProjectId(next);
                    // The task belonged to the old project, and the activity
                    // list may not survive the move either.
                    setWorkPackageId(undefined);
                    setActivityId(undefined);
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="time-task">Task</Label>
                <ComboSelect
                  id="time-task"
                  label="Task"
                  options={taskOptions}
                  value={workPackageId}
                  clearable
                  disabled={!projectId}
                  loading={tasksQuery.isLoading}
                  emptyLabel="No open tasks in this project"
                  placeholder={projectId ? 'Optional' : 'Choose a project first'}
                  onChange={setWorkPackageId}
                />
                <FieldHint>
                  Leave empty to log against the project itself.
                </FieldHint>
              </div>
            </>
          )}

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

          {/* Known before a key is pressed, so it is said before a key is pressed. */}
          {refused ? (
            <Alert tone="warning" title="You cannot log time on this project">
              You need to be a member of it with permission to log time. Ask whoever runs the
              project to add you, or pick a project you are on.
            </Alert>
          ) : null}

          {/*
            The refusal, in terms the reader can act on.

            OpenProject answers a caller with no `log_time` in the project with
            "You are not authorized to access this resource" — true, and useless:
            it names no project, no permission and no remedy, and it appears
            identically whether the person picked the wrong project or simply is
            not on it. The cause is almost always the same, so it is said.
          */}
          {error ? (
            <FieldError>
              {/^you are not authorized/i.test(error)
                ? 'You cannot log time on this project. You need to be a member of it with permission to log time — ask whoever runs the project to add you.'
                : error}
            </FieldError>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={pending}
            disabled={refused}
            title={refused ? 'You cannot log time on this project' : undefined}
          >
            {editing ? 'Save changes' : 'Log time'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
