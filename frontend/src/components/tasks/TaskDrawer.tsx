import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { SchemaForm } from '@/components/common/SchemaForm';
import { MemberDialog } from '@/components/projects/MemberDialog';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { useProjects } from '@/hooks/useProjects';
import {
  useProjectAssignees,
  useProjectTypes,
  useStatuses,
  useWorkPackageCreateForm,
} from '@/hooks/useCatalog';
import { useSprints } from '@/hooks/useSprints';
import { useCreateTask, useTasks } from '@/hooks/useTasks';
import { msg, t } from '@/lib/i18n';
import { allowedValuesOf, idFromHref, schemaField, writableFields } from '@/services/api/forms';
import type { CreateTaskInput } from '@/types';

const NONE = '__none__';

const schema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(4, msg('Give the task a title of at least 4 characters.'))
      .max(140, msg('Keep the title under 140 characters.')),
    description: z.string().max(4000, msg('Description is too long.')).optional(),
    // A native OpenProject type id, not an EPM category: only the project
    // knows which types it enables.
    typeId: z.string().min(1, msg('Select a work package type.')),
    // The instance's own, from the project's create form. Empty only while that
    // form is on its way, when the delivery system's defaults are what it would
    // have selected anyway.
    statusId: z.string().optional(),
    priorityId: z.string().optional(),
    projectId: z.string().min(1, msg('Select the project this work belongs to.')),
    assigneeId: z.string().optional(),
    parentId: z.string().optional(),
    sprintId: z.string().optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    estimatedHours: z
      .string()
      .optional()
      .refine((value) => !value || (Number(value) > 0 && Number(value) <= 400), {
        message: msg('Estimate must be between 0 and 400 hours.'),
      }),
    storyPoints: z.string().optional(),
    labels: z.string().optional(),
  })
  .refine(
    (values) => !values.startDate || !values.dueDate || values.startDate <= values.dueDate,
    { message: msg('The due date must be on or after the start date.'), path: ['dueDate'] },
  );

type FormValues = z.infer<typeof schema>;

const DEFAULTS: FormValues = {
  subject: '',
  description: '',
  typeId: '',
  statusId: '',
  priorityId: '',
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
  const { data: statuses } = useStatuses();
  const createTask = useCreateTask();
  // Declared early: which projects are offered is decided by what this person may do.
  const { canInProject } = useAuth();

  /*
   * Only the projects this person may add work to.
   *
   * A public project is visible to anyone signed in, so offering everything visible
   * offered projects where the server then refused the task with "You do not have
   * permission to create work packages".
   */
  const creatable = useMemo(
    () => (projects ?? []).filter((project) => canInProject(project.id, 'task:create')),
    [projects, canInProject],
  );

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
  const statusId = watch('statusId');
  const priorityId = watch('priorityId');
  const sprintId = watch('sprintId');

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

  /*
   * Statuses, priorities and sprints are asked of the project's own create form.
   *
   * These lists were EPM's categories, Backlog to Blocked and Critical to Low, so
   * the dialog offered "To Do" and "Medium" on an instance that has "New" and
   * "Normal", and a priority an administrator added could not be chosen. Each
   * category then saved as whichever status stood for it. The sprints were every
   * project's, though a task can only take one its own project has.
   */
  const { data: createForm } = useWorkPackageCreateForm(projectId && typeId ? projectId : undefined, typeId || undefined);
  const optionsOf = (name: string) => {
    const field = schemaField(createForm, name);
    return (field ? allowedValuesOf(field) : undefined) ?? [];
  };
  const statusOptions = optionsOf('status');
  const priorityOptions = optionsOf('priority');
  const sprintOptions = schemaField(createForm, 'version') ? optionsOf('version') : optionsOf('targetVersions');
  const formDefault = (name: string) => {
    const links = createForm?.payload._links as Record<string, { href?: string | null } | undefined> | undefined;
    return idFromHref(links?.[name]?.href ?? undefined);
  };

  /*
   * The custom fields a task of this type cannot be saved without.
   *
   * The rest wait for Edit all fields, as everything this dialog does not carry
   * does. These cannot: the delivery system refuses the task without them, and a
   * required field nobody could reach here stopped anyone adding work to the project.
   */
  const requiredFields = useMemo(
    () =>
      createForm
        ? writableFields(createForm.schema)
            .filter(([key, field]) => /^customField\d+$/.test(key) && field.required)
            .map(([key]) => key)
        : [],
    [createForm],
  );
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});

  // Only the project's team can be assigned, so a project nobody has been
  // added to offers no one — which read as a broken picker. Whoever may manage
  // the team can add people from here; the list refreshes when they do.
  const mayAddPeople = Boolean(projectId) && canInProject(projectId, 'member:manage');
  const [addingPeople, setAddingPeople] = useState(false);
  const addPeople = mayAddPeople ? (
    <button
      type="button"
      onClick={() => setAddingPeople(true)}
      className="rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('Add people to this project')}
    </button>
  ) : null;

  // Parent candidates are scoped to the selected project.
  const { data: parentCandidates } = useTasks({
    projectId: projectId || undefined,
    pageSize: 40,
    sortBy: 'updatedAt',
    sortDir: 'desc',
  });

  /** The project to start in: the one it was opened for, if work can be added there. */
  const startingProject = () => {
    const mayAddTo = (id?: string) => (creatable.some((project) => project.id === id) ? id : undefined);
    // A sprint board opens this with a sprint and no project: the sprint's, then.
    const ofSprint = sprints?.find((sprint) => sprint.id === taskDrawerPrefill.sprintId)?.projectIds.find(mayAddTo);
    return mayAddTo(taskDrawerPrefill.projectId) ?? ofSprint ?? creatable[0]?.id ?? '';
  };

  // Once per opening: the lists below can arrive or refresh while someone is typing.
  useEffect(() => {
    if (!taskDrawerOpen) return;
    setCustomValues({});
    reset({
      ...DEFAULTS,
      ...Object.fromEntries(
        Object.entries(taskDrawerPrefill).filter(([, value]) => value !== undefined),
      ),
      projectId: startingProject(),
      assigneeId: taskDrawerPrefill.assigneeId ?? NONE,
      sprintId: taskDrawerPrefill.sprintId ?? NONE,
    } as FormValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskDrawerOpen, taskDrawerPrefill, reset]);

  // Opened before the projects had loaded, it takes one when they do.
  useEffect(() => {
    if (taskDrawerOpen && !projectId && creatable.length > 0) setValue('projectId', startingProject());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskDrawerOpen, projectId, creatable, setValue]);

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
   * The same for what the form offers: a status, priority or sprint chosen under
   * another project or type may not be one this form takes.
   *
   * Opened from a board column, the status starts in that column if the form has
   * one that falls in it, so the card lands where it was asked for. Otherwise what
   * the form would have selected itself: "New" and "Normal" on a stock instance.
   */
  useEffect(() => {
    if (!taskDrawerOpen || !createForm) return;
    const offered = (options: { id: string }[], id?: string) => options.some((option) => option.id === id);

    const column = taskDrawerPrefill.status;
    if (!offered(statusOptions, statusId) && (!column || statuses)) {
      const inColumn = column
        ? statusOptions.find((option) => statuses?.find((status) => status.id === option.id)?.category === column)
        : undefined;
      setValue('statusId', inColumn?.id ?? formDefault('status') ?? statusOptions[0]?.id ?? '');
    }
    if (!offered(priorityOptions, priorityId)) {
      setValue('priorityId', formDefault('priority') ?? priorityOptions[0]?.id ?? '');
    }
    if (sprintId && sprintId !== NONE && !offered(sprintOptions, sprintId)) setValue('sprintId', NONE);
    // The options are worked out from the form on each render; the form is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskDrawerOpen, createForm, statuses, statusId, priorityId, sprintId, taskDrawerPrefill, setValue]);

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
      statusId: values.statusId || undefined,
      priorityId: values.priorityId || undefined,
      // Saved before the form answered, the column it was opened from still counts.
      status: values.statusId ? undefined : taskDrawerPrefill.status,
      customValues: requiredFields.some((key) => key in customValues)
        ? Object.fromEntries(requiredFields.filter((key) => key in customValues).map((key) => [key, customValues[key]]))
        : undefined,
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
      toast.success(t('Task created successfully'), { description: `${created.key} · ${created.subject}` });
      closeTaskDrawer();
    } catch (error) {
      toast.error(t('Unable to create the task'), {
        description: error instanceof Error ? error.message : t('Please try again.'),
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
          <DialogTitle>{t('Create task')}</DialogTitle>
          <DialogDescription>
            {t('New work packages are created through the EPM backend.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="epm-dialog-body epm-scroll -me-1 space-y-3 py-1 pe-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-subject" required>
                {t('Title')}
              </Label>
              <Input
                id="task-subject"
                autoFocus
                placeholder={t('Implement Redis caching layer')}
                invalid={Boolean(errors.subject)}
                aria-describedby="task-subject-hint"
                {...register('subject')}
              />
              {errors.subject ? (
                <FieldError>{t(errors.subject.message ?? '')}</FieldError>
              ) : (
                <FieldHint id="task-subject-hint">
                  {t('Describe the outcome, not the activity.')}
                </FieldHint>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-description">{t('Description')}</Label>
              <Textarea
                id="task-description"
                rows={3}
                placeholder={t('Acceptance criteria, links and context for whoever picks this up.')}
                invalid={Boolean(errors.description)}
                {...register('description')}
              />
              {errors.description ? <FieldError>{t(errors.description.message ?? '')}</FieldError> : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormSelect
                id="task-project"
                label={t('Project')}
                required
                value={watch('projectId')}
                onChange={(value) => setValue('projectId', value, { shouldValidate: true })}
                error={errors.projectId?.message}
                hint={projects && creatable.length === 0 ? t('You cannot add tasks to any project.') : undefined}
                placeholder={t('Select a project')}
                options={creatable.map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
              />

              <FormSelect
                id="task-type"
                label={t('Type')}
                required
                value={watch('typeId')}
                onChange={(value) => setValue('typeId', value, { shouldValidate: true })}
                error={errors.typeId?.message}
                placeholder={projectId ? t('Select a type') : t('Select a project first')}
                options={(projectTypes ?? []).map((type) => ({
                  value: type.id,
                  label: type.name,
                }))}
              />

              <FormSelect
                id="task-status"
                label={t('Status')}
                required
                value={statusId ?? ''}
                onChange={(value) => setValue('statusId', value)}
                placeholder={projectId ? t('Loading…') : t('Select a project first')}
                options={statusOptions.map((status) => ({ value: status.id, label: status.name }))}
              />

              <FormSelect
                id="task-priority"
                label={t('Priority')}
                required
                value={priorityId ?? ''}
                onChange={(value) => setValue('priorityId', value)}
                placeholder={projectId ? t('Loading…') : t('Select a project first')}
                options={priorityOptions.map((priority) => ({ value: priority.id, label: priority.name }))}
              />

              <FormSelect
                id="task-assignee"
                label={t('Assignee')}
                value={watch('assigneeId') ?? NONE}
                onChange={(value) => setValue('assigneeId', value)}
                hint={
                  !projectId ? (
                    t('Select a project first.')
                  ) : assignees && assignees.length === 0 ? (
                    <>
                      {t('Only people in the project’s team can be assigned, and it has nobody yet.')}{' '}
                      {addPeople ?? t('Ask a project admin to add people to it.')}
                    </>
                  ) : (
                    addPeople ?? undefined
                  )
                }
                options={[
                  { value: NONE, label: t('Unassigned') },
                  ...(assignees ?? []).map((person) => ({
                    value: person.id,
                    label: person.name,
                  })),
                ]}
              />

              <FormSelect
                id="task-sprint"
                label={t('Sprint')}
                value={watch('sprintId') ?? NONE}
                onChange={(value) => setValue('sprintId', value)}
                options={[
                  { value: NONE, label: t('Backlog') },
                  ...sprintOptions.map((sprint) => ({ value: sprint.id, label: sprint.name })),
                ]}
              />

              <FormSelect
                id="task-parent"
                label={t('Parent task')}
                value={watch('parentId') ?? NONE}
                hint={t('Optional. Groups this item under an epic or parent.')}
                onChange={(value) => setValue('parentId', value)}
                options={[
                  { value: NONE, label: t('None') },
                  ...(parentCandidates?.items ?? []).map((task) => ({
                    value: task.id,
                    label: `${task.key} · ${task.subject}`,
                  })),
                ]}
              />

              <div className="space-y-1.5">
                <Label htmlFor="task-points">{t('Story points')}</Label>
                <Input
                  id="task-points"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="5"
                  {...register('storyPoints')}
                />
                <FieldHint>{t('Used by sprint velocity reporting.')}</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-start">{t('Start date')}</Label>
                <Input id="task-start" type="date" {...register('startDate')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-due">{t('Due date')}</Label>
                <Input
                  id="task-due"
                  type="date"
                  invalid={Boolean(errors.dueDate)}
                  {...register('dueDate')}
                />
                {errors.dueDate ? <FieldError>{t(errors.dueDate.message ?? '')}</FieldError> : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-estimate">{t('Estimated hours')}</Label>
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
                  <FieldError>{t(errors.estimatedHours.message ?? '')}</FieldError>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-labels">{t('Labels')}</Label>
                <Input id="task-labels" placeholder={t('backend, performance')} {...register('labels')} />
                <FieldHint>{t('Comma separated.')}</FieldHint>
              </div>
            </div>

            {requiredFields.length > 0 ? (
              <SchemaForm
                form={createForm}
                values={customValues}
                errors={{}}
                onChange={(field, value) => setCustomValues((current) => ({ ...current, [field]: value }))}
                only={requiredFields}
              />
            ) : null}
          </div>

          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" onClick={closeTaskDrawer}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting || createTask.isPending}>
              {t('Create Task')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {projectId ? <MemberDialog open={addingPeople} onOpenChange={setAddingPeople} projectId={projectId} /> : null}
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
  hint?: ReactNode;
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
          <SelectValue placeholder={placeholder ?? t('Select {label}', { label: label.toLowerCase() })} />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <FieldError>{t(error)}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
