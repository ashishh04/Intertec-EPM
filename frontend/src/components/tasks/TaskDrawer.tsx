import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  ALL_TASK_PRIORITIES,
  ALL_TASK_STATUSES,
  TASK_PRIORITY_META,
  TASK_STATUS_META,
} from '@/lib/domain';
import { useUI } from '@/providers/UIProvider';
import { useProjects } from '@/hooks/useProjects';
import { useProjectAssignees, useProjectTypes } from '@/hooks/useCatalog';
import { useSprints } from '@/hooks/useSprints';
import { useCreateTask, useTasks } from '@/hooks/useTasks';
import type { CreateTaskInput, TaskPriority, TaskStatusCategory } from '@/types';

const NONE = '__none__';

const schema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(4, 'Give the task a title of at least 4 characters.')
      .max(140, 'Keep the title under 140 characters.'),
    description: z.string().max(4000, 'Description is too long.').optional(),
    // A native OpenProject type id, not an EPM category: only the project
    // knows which types it enables.
    typeId: z.string().min(1, 'Select a work package type.'),
    status: z.string().min(1, 'Select a status.'),
    priority: z.string().min(1, 'Select a priority.'),
    projectId: z.string().min(1, 'Select the project this work belongs to.'),
    assigneeId: z.string().optional(),
    parentId: z.string().optional(),
    sprintId: z.string().optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    estimatedHours: z
      .string()
      .optional()
      .refine((value) => !value || (Number(value) > 0 && Number(value) <= 400), {
        message: 'Estimate must be between 0 and 400 hours.',
      }),
    storyPoints: z.string().optional(),
    labels: z.string().optional(),
  })
  .refine(
    (values) => !values.startDate || !values.dueDate || values.startDate <= values.dueDate,
    { message: 'The due date must be on or after the start date.', path: ['dueDate'] },
  );

type FormValues = z.infer<typeof schema>;

const DEFAULTS: FormValues = {
  subject: '',
  description: '',
  typeId: '',
  status: 'todo',
  priority: 'medium',
  projectId: '',
  assigneeId: NONE,
  parentId: NONE,
  sprintId: NONE,
  startDate: '',
  dueDate: '',
  estimatedHours: '',
  storyPoints: '',
  labels: '',
};

/**
 * Task composer. Opens from the header, the command palette, board columns and
 * empty states, and carries a prefill so the surrounding context is preserved.
 */
export function TaskDrawer() {
  const { taskDrawerOpen, taskDrawerPrefill, closeTaskDrawer } = useUI();
  const { data: projects } = useProjects();
  const { data: sprints } = useSprints();
  const createTask = useCreateTask();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });

  const projectId = watch('projectId');
  const typeId = watch('typeId');
  const assigneeId = watch('assigneeId');

  /*
   * Types and assignees are asked of the project, not the instance.
   *
   * A project enables a subset of the instance's types and admits a subset of
   * its people. Offering the full lists let a user pick a combination
   * OpenProject then refused — "Type is not set to one of the allowed values"
   * for Feature and Bug, and "The chosen user is not allowed to be 'Assignee'
   * for this work package" for anyone outside the project.
   */
  const { data: projectTypes } = useProjectTypes(projectId || undefined);
  const { data: assignees } = useProjectAssignees(projectId || undefined);

  // Parent candidates are scoped to the selected project.
  const { data: parentCandidates } = useTasks({
    projectId: projectId || undefined,
    pageSize: 40,
    sortBy: 'updatedAt',
    sortDir: 'desc',
  });

  useEffect(() => {
    if (!taskDrawerOpen) return;
    reset({
      ...DEFAULTS,
      ...Object.fromEntries(
        Object.entries(taskDrawerPrefill).filter(([, value]) => value !== undefined),
      ),
      projectId: taskDrawerPrefill.projectId ?? projects?.[0]?.id ?? '',
      status: taskDrawerPrefill.status ?? 'todo',
      assigneeId: taskDrawerPrefill.assigneeId ?? NONE,
      sprintId: taskDrawerPrefill.sprintId ?? NONE,
    } as FormValues);
  }, [taskDrawerOpen, taskDrawerPrefill, projects, reset]);

  /*
   * Hold the type to something this project actually enables.
   *
   * Switching project changes the permitted set, so a type chosen under the
   * previous one can become invalid without the user touching the field. The
   * project's default is preferred, falling back to the first it offers.
   */
  useEffect(() => {
    if (!taskDrawerOpen || !projectTypes) return;
    if (projectTypes.some((type) => type.id === typeId)) return;

    const fallback = projectTypes.find((type) => type.isDefault) ?? projectTypes[0];
    setValue('typeId', fallback?.id ?? '', { shouldValidate: Boolean(typeId) });
  }, [taskDrawerOpen, projectTypes, typeId, setValue]);

  /*
   * An assignee the project will not accept cannot stay selected.
   *
   * My Work opens this dialog pre-assigned to the signed-in person, who is not
   * necessarily a member of the default project — which is how a create ended
   * in "The chosen user is not allowed to be 'Assignee' for this work package".
   * Falling back to Unassigned keeps the form submittable and visibly honest
   * about what changed.
   */
  useEffect(() => {
    if (!taskDrawerOpen || !assignees) return;
    if (!assigneeId || assigneeId === NONE) return;
    if (!assignees.some((person) => person.id === assigneeId)) setValue('assigneeId', NONE);
  }, [taskDrawerOpen, assignees, assigneeId, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    const input: CreateTaskInput = {
      subject: values.subject.trim(),
      description: values.description?.trim() || undefined,
      typeId: values.typeId,
      status: values.status as TaskStatusCategory,
      priority: values.priority as TaskPriority,
      projectId: values.projectId,
      assigneeId: values.assigneeId === NONE ? undefined : values.assigneeId,
      parentId: values.parentId === NONE ? undefined : values.parentId,
      sprintId: values.sprintId === NONE ? undefined : values.sprintId,
      startDate: values.startDate || undefined,
      dueDate: values.dueDate || undefined,
      estimatedHours: values.estimatedHours ? Number(values.estimatedHours) : undefined,
      storyPoints: values.storyPoints ? Number(values.storyPoints) : undefined,
      labels: values.labels
        ? values.labels
            .split(',')
            .map((label) => label.trim().toLowerCase())
            .filter(Boolean)
        : [],
    };

    try {
      const created = await createTask.mutateAsync(input);
      toast.success('Task created successfully', { description: `${created.key} · ${created.subject}` });
      closeTaskDrawer();
    } catch (error) {
      toast.error('Unable to create the task', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    }
  });

  return (
    <Dialog open={taskDrawerOpen} onOpenChange={(open) => (open ? null : closeTaskDrawer())}>
      {/* Centred rather than a side panel: creating a task is a focused,
          self-contained action, and every other create surface here is a
          dialog. A drawer also fought the page underneath for attention. */}
      <DialogContent className="sm:max-w-[40rem]">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>
            New work packages are created through the EPM backend.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="epm-dialog-body epm-scroll -mr-1 space-y-3 py-1 pr-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-subject" required>
                Title
              </Label>
              <Input
                id="task-subject"
                autoFocus
                placeholder="Implement Redis caching layer"
                invalid={Boolean(errors.subject)}
                aria-describedby="task-subject-hint"
                {...register('subject')}
              />
              {errors.subject ? (
                <FieldError>{errors.subject.message}</FieldError>
              ) : (
                <FieldHint id="task-subject-hint">
                  Describe the outcome, not the activity.
                </FieldHint>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-description">Description</Label>
              <Textarea
                id="task-description"
                rows={3}
                placeholder="Acceptance criteria, links and context for whoever picks this up."
                invalid={Boolean(errors.description)}
                {...register('description')}
              />
              {errors.description ? <FieldError>{errors.description.message}</FieldError> : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormSelect
                id="task-project"
                label="Project"
                required
                value={watch('projectId')}
                onChange={(value) => setValue('projectId', value, { shouldValidate: true })}
                error={errors.projectId?.message}
                placeholder="Select a project"
                options={(projects ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
              />

              <FormSelect
                id="task-type"
                label="Type"
                required
                value={watch('typeId')}
                onChange={(value) => setValue('typeId', value, { shouldValidate: true })}
                error={errors.typeId?.message}
                placeholder={projectId ? 'Select a type' : 'Select a project first'}
                options={(projectTypes ?? []).map((type) => ({
                  value: type.id,
                  label: type.name,
                }))}
              />

              <FormSelect
                id="task-status"
                label="Status"
                required
                value={watch('status')}
                onChange={(value) => setValue('status', value, { shouldValidate: true })}
                error={errors.status?.message}
                options={ALL_TASK_STATUSES.map((status) => ({
                  value: status,
                  label: TASK_STATUS_META[status].label,
                }))}
              />

              <FormSelect
                id="task-priority"
                label="Priority"
                required
                value={watch('priority')}
                onChange={(value) => setValue('priority', value, { shouldValidate: true })}
                error={errors.priority?.message}
                options={ALL_TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: TASK_PRIORITY_META[priority].label,
                }))}
              />

              <FormSelect
                id="task-assignee"
                label="Assignee"
                value={watch('assigneeId') ?? NONE}
                onChange={(value) => setValue('assigneeId', value)}
                hint={projectId ? undefined : 'Select a project first.'}
                options={[
                  { value: NONE, label: 'Unassigned' },
                  ...(assignees ?? []).map((person) => ({
                    value: person.id,
                    label: person.name,
                  })),
                ]}
              />

              <FormSelect
                id="task-sprint"
                label="Sprint"
                value={watch('sprintId') ?? NONE}
                onChange={(value) => setValue('sprintId', value)}
                options={[
                  { value: NONE, label: 'Backlog' },
                  ...(sprints ?? []).map((sprint) => ({ value: sprint.id, label: sprint.name })),
                ]}
              />

              <FormSelect
                id="task-parent"
                label="Parent task"
                value={watch('parentId') ?? NONE}
                hint="Optional. Groups this item under an epic or parent."
                onChange={(value) => setValue('parentId', value)}
                options={[
                  { value: NONE, label: 'None' },
                  ...(parentCandidates?.items ?? []).map((task) => ({
                    value: task.id,
                    label: `${task.key} · ${task.subject}`,
                  })),
                ]}
              />

              <div className="space-y-1.5">
                <Label htmlFor="task-points">Story points</Label>
                <Input
                  id="task-points"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="5"
                  {...register('storyPoints')}
                />
                <FieldHint>Used by sprint velocity reporting.</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-start">Start date</Label>
                <Input id="task-start" type="date" {...register('startDate')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  invalid={Boolean(errors.dueDate)}
                  {...register('dueDate')}
                />
                {errors.dueDate ? <FieldError>{errors.dueDate.message}</FieldError> : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-estimate">Estimated hours</Label>
                <Input
                  id="task-estimate"
                  type="number"
                  min={0}
                  step={0.5}
                  placeholder="8"
                  invalid={Boolean(errors.estimatedHours)}
                  {...register('estimatedHours')}
                />
                {errors.estimatedHours ? (
                  <FieldError>{errors.estimatedHours.message}</FieldError>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-labels">Labels</Label>
                <Input id="task-labels" placeholder="backend, performance" {...register('labels')} />
                <FieldHint>Comma separated.</FieldHint>
              </div>
            </div>
          </div>

          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" onClick={closeTaskDrawer}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || createTask.isPending}>
              Create Task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface FormSelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  required?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
}

/** Labelled select with hint and error slots, matching the form UX rules. */
function FormSelect({
  id,
  label,
  value,
  onChange,
  options,
  required,
  error,
  hint,
  placeholder,
}: FormSelectProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} invalid={Boolean(error)}>
          <SelectValue placeholder={placeholder ?? `Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
