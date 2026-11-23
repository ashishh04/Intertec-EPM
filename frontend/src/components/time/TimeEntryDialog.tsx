import { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, LifeBuoy, Users } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect, type ComboOption } from '@/components/common/ComboSelect';
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
import { useDebounce } from '@/hooks/useDebounce';
import { useLogTime, useUpdateTimeEntry } from '@/hooks/useTimeEntries';
import { useProjects } from '@/hooks/useProjects';
import { useTask, useTaskCategories, useTaskTimeline, useTasks } from '@/hooks/useTasks';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { t } from '@/lib/i18n';
import { cn, formatHours, formatShortDate } from '@/lib/utils';
import { formService } from '@/services';
import { allowedValuesOf, schemaField } from '@/services/api/forms';
import type { EpmTask, EpmTimeEntry, ID, MeetingType, TimeKind } from '@/types';

/**
 * Creates or edits a time entry from the timesheet.
 *
 * This is the standalone form, as opposed to `tasks/LogTimeDialog`, which logs
 * against a work package already on screen and therefore needs no pickers. Here
 * the entry has no context: the person is filling in a week, so the project is
 * theirs to choose, then the task. Project work needs a task. A daily scrum, a
 * follow-up and support need no project at all: without one the time is the
 * person's own, kept by EPM, and counts in their week and utilisation.
 *
 * The task picker offers every task in the project, parents and subtasks, as
 * the plan has them: each under its parent, in date order, with its dates. It
 * used to offer the hundred open ones touched most recently — and a parent is
 * touched whenever one of its children is, so a planned project showed its
 * summary tasks and a few subtasks, and the task somebody had worked on was
 * often not there to choose, not even by typing its name. A closed task is
 * still offered, quieter, because time is often logged after the work closes.
 * The chosen task's dates, the time already logged on it and its description
 * are shown under the picker, so the person can see it is the right one.
 *
 * Where the project's tasks have categories, the picker lists them category by
 * category — development, testing, review — in the field's order, each in the
 * plan's order. Review and management tasks are a manager's: anyone else sees
 * them, marked "Managers only", and cannot choose them (the server refuses the
 * entry too).
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

/**
 * What the time was for. Project work is logged against a task; scrums and
 * meetings, and support, are time no one task owns. With a project they go on
 * the project's own task for that kind of time; a daily scrum, a follow-up or
 * support with no project is the person's own time — so a manager who spent
 * the morning in meetings chooses "Scrums & meetings", which meeting, and
 * writes what it was about.
 */
const TIME_KINDS: { id: TimeKind; label: string; icon: typeof Briefcase }[] = [
  { id: 'project', get label() { return t('Project work'); }, icon: Briefcase },
  { id: 'meeting', get label() { return t('Scrums & meetings'); }, icon: Users },
  { id: 'support', get label() { return t('Support'); }, icon: LifeBuoy },
];

/** Which meeting. A daily scrum or a follow-up is no one project's, so it needs none. */
const MEETING_TYPES: { id: MeetingType; label: string }[] = [
  { id: 'daily', get label() { return t('Daily scrum'); } },
  { id: 'follow_up', get label() { return t('Follow-up'); } },
  { id: 'project', get label() { return t('Project meeting'); } },
];

/** A task in the picker's tree: how deep it sits, and its parent's name for the hint. */
interface TreeRow {
  task: EpmTask;
  depth: number;
  parentName?: string;
}

/** Undated work sorts after dated work, and ties fall back to the order it was created in. */
function planOrder(a: EpmTask, b: EpmTask): number {
  const day = (task: EpmTask) => task.startDate ?? task.dueDate ?? '9999-12-31';
  return day(a).localeCompare(day(b)) || Number(a.id) - Number(b.id);
}

/**
 * The project's tasks as the plan reads: each parent followed by its subtasks,
 * siblings in date order. A task whose parent is not in the list (another
 * project's, or beyond what was read) starts a tree of its own.
 */
function taskTree(tasks: EpmTask[]): TreeRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenOf = new Map<ID | undefined, EpmTask[]>();
  for (const task of tasks) {
    const parent = task.parentId && byId.has(task.parentId) ? task.parentId : undefined;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), task]);
  }

  const rows: TreeRow[] = [];
  const seen = new Set<ID>();
  const visit = (parent: ID | undefined, depth: number) => {
    for (const task of (childrenOf.get(parent) ?? []).sort(planOrder)) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      rows.push({ task, depth, parentName: parent ? byId.get(parent)?.subject : undefined });
      visit(task.id, depth + 1);
    }
  };
  visit(undefined, 0);
  // Anything a broken parent chain left out still has to be choosable.
  for (const task of tasks) if (!seen.has(task.id)) rows.push({ task, depth: 0 });
  return rows;
}

/** "12 Nov – 20 Nov", or as much of it as the task has. */
function dateSpan(task: EpmTask): string | undefined {
  if (task.startDate && task.dueDate && task.startDate !== task.dueDate) {
    return `${formatShortDate(task.startDate)} – ${formatShortDate(task.dueDate)}`;
  }
  if (task.dueDate ?? task.startDate) return formatShortDate(task.dueDate ?? task.startDate);
  return undefined;
}

function optionOf(row: TreeRow): ComboOption {
  const { task } = row;
  const closed = task.status.isClosed;
  return {
    id: task.id,
    name: task.subject,
    hint: [
      task.key,
      row.parentName ? t('in {parent}', { parent: row.parentName }) : undefined,
      task.spentHours ? t('{hours} logged', { hours: formatHours(task.spentHours) }) : undefined,
      closed ? task.status.name : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    depth: row.depth,
    aside: dateSpan(task),
    muted: closed,
  };
}

/** What the picker needs of the categories: their order, and which the person may not log on. */
interface CategoryRules {
  rank: Map<ID, number>;
  barred: Set<ID>;
}

/**
 * The options category by category, in the field's order, each keeping the
 * order it came in. Grouping breaks the tree, so every row is drawn flat, its
 * parent named in the hint. Without a category anywhere, the tree is kept.
 */
function categorised(rows: TreeRow[], rules: CategoryRules): ComboOption[] {
  if (!rows.some((row) => row.task.category)) return rows.map(optionOf);
  const rankOf = (row: TreeRow) =>
    row.task.category ? (rules.rank.get(row.task.category.id) ?? rules.rank.size) : Number.POSITIVE_INFINITY;
  return rows
    .map((row, index) => ({ row, index, rank: rankOf(row) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ row }) => {
      const option = optionOf({ ...row, depth: 0 });
      const category = row.task.category;
      const barred = category ? rules.barred.has(category.id) : false;
      return {
        ...option,
        group: category ? (barred ? t('{category} · managers only', { category: category.name }) : category.name) : undefined,
        disabled: barred,
        hint: barred ? [t('Managers only'), option.hint].filter(Boolean).join(' · ') : option.hint,
      };
    });
}

/** How many of a project's tasks a server search offers, when the project is too big to hold. */
const SEARCH_RESULTS = 50;

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
  const [taskSearch, setTaskSearch] = useState('');
  const searchTerm = useDebounce(taskSearch.trim(), 250);
  // What the time was: work on a task, scrums and meetings, or support.
  const [kind, setKind] = useState<TimeKind>('project');
  const [meetingType, setMeetingType] = useState<MeetingType>('daily');
  const onTask = kind === 'project';
  // Only project work and a project's meeting need a project.
  const projectRequired = onTask || (kind === 'meeting' && meetingType === 'project');

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
    setTaskSearch('');
    setKind('project');
    setMeetingType('daily');
  }, [open, entry, initialDate, initialProject]);

  const projectsQuery = useProjects();
  const categoriesQuery = useTaskCategories();
  const rules = useMemo((): CategoryRules => {
    const options = categoriesQuery.data?.options ?? [];
    return {
      rank: new Map(options.map((option, index) => [option.id, index])),
      barred: new Set(options.filter((option) => option.allowed === false).map((option) => option.id)),
    };
  }, [categoriesQuery.data]);

  /*
   * Every task in the project, open or closed, parents and subtasks — read
   * across pages, as the project's timeline reads it (and from the same cache),
   * up to a thousand. Only once a project is chosen.
   */
  const projectTasks = useTaskTimeline(open && !editing ? projectId : undefined);
  const loadedTasks = useMemo(() => projectTasks.data?.items ?? [], [projectTasks.data]);
  // Beyond what one read holds, typing searches the whole project upstream.
  const truncated = (projectTasks.data?.total ?? 0) > loadedTasks.length;
  const searching = truncated && searchTerm.length >= 2;
  const searchQuery = useTasks(
    { projectId, search: searchTerm, pageSize: SEARCH_RESULTS },
    { enabled: open && !editing && Boolean(projectId) && searching },
  );

  // The entry being edited, or the task just chosen, in full: its dates, the
  // time logged on it and its description, for the summary under the picker.
  const listed = loadedTasks.find((task) => task.id === workPackageId)
    ?? searchQuery.data?.items.find((task) => task.id === workPackageId);
  const taskQuery = useTask(open && workPackageId && !listed ? workPackageId : undefined);
  const chosenTask = listed ?? taskQuery.data;

  /*
   * The activities this project allows.
   *
   * Asked for with the scope the entry will actually be written at, because an
   * instance may narrow the list per project — reading it once globally would
   * offer activities the write then refuses.
   */
  // Scrums and meetings, and support, go on the project's own task for them:
  // the form is asked about that task (the server finds it), as the entry will
  // be written. Asked about the project alone, as before a task is chosen, the
  // server checks one of its tasks: about a project, someone who may log only
  // their own time (the Member role) is refused, though they may log on its
  // tasks.
  const formKind = !workPackageId && kind !== 'project' ? kind : undefined;
  const form = useSchemaForm(
    (payload) =>
      formService.timeEntryForm(
        workPackageId ? { workPackageId, projectId } : { projectId, ...(formKind ? { kind: formKind } : {}) },
        payload,
      ),
    { enabled: open && Boolean(projectId || workPackageId) },
  );

  // Asked again when what the entry is written at changes: another project,
  // task or kind of time can be allowed or refused, and offer other
  // activities. The first ask is the form's own, when a project or task is
  // first chosen.
  const formScope = `${projectId ?? ''}|${workPackageId ?? ''}|${formKind ?? ''}`;
  const askedScope = useRef<string | undefined>(undefined);
  const reloadForm = form.reset;
  useEffect(() => {
    if (!open || !(projectId || workPackageId)) {
      askedScope.current = undefined;
      return;
    }
    if (askedScope.current === undefined) askedScope.current = formScope;
    else if (askedScope.current !== formScope) {
      askedScope.current = formScope;
      reloadForm();
    }
  }, [open, projectId, workPackageId, formScope, reloadForm]);

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
  const refused = Boolean(projectId || workPackageId) && /^you are not authorized/i.test(form.error?.message ?? '');

  // Default to whatever the instance offers first, once it has answered. An
  // entry being edited keeps its own activity even if it is no longer offered.
  useEffect(() => {
    if (activityId || activities.length === 0) return;
    setActivityId(activities[0]!.id);
  }, [activityId, activities]);

  // Scrums and meetings, or support, take the instance's activity of that name
  // where it has one, so the time is reported as what it was.
  useEffect(() => {
    if (editing || kind === 'project' || activities.length === 0) return;
    const pattern = kind === 'meeting' ? /meet|scrum|stand.?up/i : /support/i;
    const match = activities.find((activity) => pattern.test(activity.name));
    if (match) setActivityId(match.id);
  }, [editing, kind, activities]);

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  const taskOptions = useMemo(() => {
    if (searching) {
      // Search results come flat; their parents' names say where each sits.
      const names = new Map(loadedTasks.map((task) => [task.id, task.subject]));
      return categorised(
        (searchQuery.data?.items ?? []).map((task) => ({
          task,
          depth: 0,
          parentName: task.parentId ? names.get(task.parentId) : undefined,
        })),
        rules,
      );
    }
    return categorised(taskTree(loadedTasks), rules);
  }, [searching, searchQuery.data, loadedTasks, rules]);

  // The chosen task stays in the list whatever the search shows now, so the
  // picker names it rather than showing its id.
  const shownTaskOptions =
    chosenTask && !taskOptions.some((option) => option.id === chosenTask.id)
      ? [optionOf({ task: chosenTask, depth: 0 }), ...taskOptions]
      : taskOptions;

  const submit = () => {
    setError(undefined);

    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      setError(t('Enter the hours worked, e.g. 1.5.'));
      return;
    }
    if (!entry && projectRequired && !projectId && !workPackageId) {
      setError(kind === 'meeting' ? t('Choose the project the meeting was for.') : t('Choose the project the time was spent on.'));
      return;
    }
    if (!entry && onTask && !workPackageId) {
      setError(t('Choose the task the time was spent on.'));
      return;
    }

    const body = {
      hours: value,
      spentOn,
      comment: comment.trim() || undefined,
      // Activities are a project's: time on no project has its kind instead.
      activityId: projectId || workPackageId ? activityId : undefined,
    };

    const done = (message: string) => {
      toast.success(message, { description: t('{hours}h on {date}', { hours: value, date: spentOn }) });
      onOpenChange(false);
    };
    // Upstream's sentence, not a generic one: "You are not allowed to log time
    // on this project" is the whole answer and the reader needs it verbatim.
    const failed = (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : t('The entry was refused.'));

    if (entry) {
      // Project and work package are deliberately not sent on an edit. They are
      // fixed for the life of the entry here, and restating them would let a
      // stale picker move somebody's time to another project by accident.
      update.mutate(
        { id: entry.id, ...body },
        { onSuccess: () => done(t('Entry updated')), onError: failed },
      );
      return;
    }

    // Scrums and meetings, or support, go on the project's own task for them,
    // or with no project are the person's own time.
    log.mutate(
      {
        ...body,
        projectId: projectId || undefined,
        workPackageId: onTask ? workPackageId : undefined,
        kind,
        meetingType: kind === 'meeting' ? meetingType : undefined,
      },
      { onSuccess: () => done(t('Time logged')), onError: failed },
    );
  };

  const tasksLoading = projectTasks.isLoading || (searching && searchQuery.isFetching && !searchQuery.data);

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('Edit entry') : t('Log time')}</DialogTitle>
          <DialogDescription>
            {editing
              ? t('The project and task this was logged against cannot be changed.')
              : onTask
                ? t('Against a task: choose the project, then the task the time was spent on.')
                : projectRequired
                  ? t('Choose the project, the hours, and say what it was. No task is needed.')
                  : t('No project or task is needed: give the hours and say what it was.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* What the time was: work on a task, or the time no one task owns. */}
          {!editing ? (
            <div className="space-y-1.5">
              <Label id="time-kind-label">{t('What was the time for?')}</Label>
              <div
                role="radiogroup"
                aria-labelledby="time-kind-label"
                className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/40 p-1"
              >
                {TIME_KINDS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === option.id}
                    data-testid={`time-kind-${option.id}`}
                    onClick={() => {
                      setKind(option.id);
                      setError(undefined);
                      // A meeting or support time goes on the project's own task.
                      if (option.id !== 'project') setWorkPackageId(undefined);
                    }}
                    className={cn(
                      'flex flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-xs font-medium transition',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      kind === option.id ? 'bg-surface text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <option.icon className="h-3.5 w-3.5" aria-hidden />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Which meeting: a daily scrum and a follow-up need no project. */}
          {!editing && kind === 'meeting' ? (
            <div className="space-y-1.5">
              <Label id="time-meeting-label">{t('Which meeting?')}</Label>
              <div
                role="radiogroup"
                aria-labelledby="time-meeting-label"
                className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/40 p-1"
              >
                {MEETING_TYPES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={meetingType === option.id}
                    data-testid={`meeting-type-${option.id}`}
                    onClick={() => {
                      setMeetingType(option.id);
                      setError(undefined);
                    }}
                    className={cn(
                      'rounded-md px-2 py-1.5 text-xs font-medium transition',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      meetingType === option.id ? 'bg-surface text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {editing ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-2xs text-muted-foreground" dir="auto">
                {entry?.projectName ?? t('Project')}
              </p>
              <p className="truncate text-xs font-medium" dir="auto">
                {entry?.workPackageSubject ?? t('Logged to the project')}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="time-project" required={projectRequired}>
                  {projectRequired ? t('Project') : t('Project (optional)')}
                </Label>
                <ComboSelect
                  id="time-project"
                  label={t('Project')}
                  options={projectOptions}
                  value={projectId}
                  clearable={!projectRequired}
                  loading={projectsQuery.isLoading}
                  emptyLabel={t('No projects match')}
                  placeholder={projectRequired ? t('Choose a project') : t('No project')}
                  onChange={(next) => {
                    setProjectId(next);
                    // The task belonged to the old project, and the activity
                    // list may not survive the move either.
                    setWorkPackageId(undefined);
                    setActivityId(undefined);
                    setTaskSearch('');
                  }}
                />
              </div>

              {!onTask ? (
                <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {!projectId
                    ? projectRequired
                      ? t('A project’s meeting is logged on that project. Choose it above.')
                      : t('With no project, the time is yours: it counts in your week, your timesheet and utilisation, and in no project’s spend or health.')
                    : kind === 'meeting'
                      ? t('Logged on the project’s “Scrums & meetings” task, which is made the first time anyone logs meeting time there. Say in the description which meeting it was.')
                      : t('Logged on the project’s “Support” task, which is made the first time anyone logs support time there. Say in the description what was supported.')}
                </p>
              ) : null}

              <div className={cn('space-y-1.5', !onTask && 'hidden')}>
                <Label htmlFor="time-task" required>
                  {t('Task')}
                </Label>
                <ComboSelect
                  id="time-task"
                  label={t('Task')}
                  options={shownTaskOptions}
                  value={workPackageId}
                  clearable
                  wide
                  disabled={!projectId}
                  loading={Boolean(projectId) && tasksLoading}
                  emptyLabel={
                    truncated && !searching
                      ? t('Type two letters or more to search all {count, number} tasks.', { count: projectTasks.data?.total ?? 0 })
                      : t('No tasks in this project match')
                  }
                  placeholder={projectId ? t('Choose a task') : t('Choose a project first')}
                  onSearch={truncated ? setTaskSearch : undefined}
                  onChange={setWorkPackageId}
                  ungroupedLabel={t('No category')}
                />
                <FieldHint>
                  {truncated
                    ? t('The first {shown, number} of {count, number} tasks are listed; type to search the rest.', {
                        shown: loadedTasks.length,
                        count: projectTasks.data?.total ?? 0,
                      })
                    : !loadedTasks.some((task) => task.category)
                      ? t('Every task in the project, each under its parent, with its dates. Overheads go on a task kept for them.')
                      : rules.barred.size > 0
                        ? t('Every task in the project, by category, with its dates. Review and management tasks are for managers.')
                        : t('Every task in the project, by category, with its dates.')}
                </FieldHint>
              </div>
            </>
          )}

          {chosenTask ? <TaskSummary task={chosenTask} /> : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="time-hours" required>
                {t('Hours')}
              </Label>
              <Input
                id="time-hours"
                inputMode="decimal"
                placeholder="1.5"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
              <FieldHint>{t('Quarters are fine.')}</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="time-date" required>
                {t('Date')}
              </Label>
              <Input
                id="time-date"
                type="date"
                value={spentOn}
                onChange={(event) => setSpentOn(event.target.value)}
              />
              {chosenTask && outsideTask(chosenTask, spentOn) ? (
                <FieldHint>{t('Outside the task’s dates — still fine to log.')}</FieldHint>
              ) : null}
            </div>
          </div>

          {/* A project's activities; time on no project has its kind instead. */}
          {(projectId || workPackageId) && activities.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="time-activity">{t('Activity')}</Label>
              <Select value={activityId} onValueChange={setActivityId}>
                <SelectTrigger id="time-activity">
                  <SelectValue placeholder={t('Select an activity')} />
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
            <Label htmlFor="time-comment">{t('Work description')}</Label>
            <Textarea
              id="time-comment"
              rows={3}
              placeholder={
                kind === 'meeting'
                  ? meetingType === 'daily'
                    ? t('e.g. Stand-up for the billing and portal projects.')
                    : meetingType === 'follow_up'
                      ? t('e.g. Followed up on the open defects with the vendor.')
                      : t('e.g. Sprint review with the client.')
                  : kind === 'support'
                    ? t('e.g. Helped the finance team with a failed report.')
                    : t('What was done in this time.')
              }
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              dir="auto"
            />
          </div>

          {/* Known before a key is pressed, so it is said before a key is pressed. */}
          {refused ? (
            <Alert tone="warning" title={t('You cannot log time on this project')}>
              {t(
                'You need to be a member of it with permission to log time. Ask whoever runs the project to add you, or pick a project you are on.',
              )}
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
                ? t(
                    'You cannot log time on this project. You need to be a member of it with permission to log time — ask whoever runs the project to add you.',
                  )
                : error}
            </FieldError>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={pending}
            disabled={refused}
            title={refused ? t('You cannot log time on this project') : undefined}
          >
            {editing ? t('Save changes') : t('Log time')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether a day falls outside a task's own dates, where it has both. */
function outsideTask(task: EpmTask, day: string): boolean {
  if (!task.startDate || !task.dueDate || !day) return false;
  return day < task.startDate.slice(0, 10) || day > task.dueDate.slice(0, 10);
}

/** A description as plain text: markup and mention tags out, whitespace folded. */
function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Above this a description is cut to three lines, with a way to read the rest. */
const LONG_DESCRIPTION = 180;

/**
 * The chosen task at a glance: when it runs, how much time is already logged on
 * it against its estimate, and what it is — enough to tell it is the right one
 * before logging against it.
 */
function TaskSummary({ task }: { task: EpmTask }) {
  const [expanded, setExpanded] = useState(false);
  const description = plainText(task.description ?? '');
  const long = description.length > LONG_DESCRIPTION;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3" data-testid="time-task-summary">
      <dl className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <dt className="epm-eyebrow">{t('Start date')}</dt>
          <dd className="mt-0.5 font-mono text-xs tabular-nums">
            {task.startDate ? formatShortDate(task.startDate) : t('Not set')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="epm-eyebrow">{t('End date')}</dt>
          <dd className="mt-0.5 font-mono text-xs tabular-nums">
            {task.dueDate ? formatShortDate(task.dueDate) : t('Not set')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="epm-eyebrow">{t('Logged')}</dt>
          <dd className="mt-0.5 font-mono text-xs tabular-nums">
            {task.estimatedHours
              ? t('{logged} of {estimated}', {
                  logged: formatHours(task.spentHours ?? 0),
                  estimated: formatHours(task.estimatedHours),
                })
              : formatHours(task.spentHours ?? 0)}
          </dd>
        </div>
      </dl>
      <div>
        <p className="epm-eyebrow">{t('Description')}</p>
        {description ? (
          <>
            <p
              className={`mt-0.5 whitespace-pre-line text-2xs leading-relaxed text-muted-foreground ${long && !expanded ? 'line-clamp-3' : ''}`}
              dir="auto"
            >
              {description}
            </p>
            {long ? (
              <button
                type="button"
                className="mt-0.5 text-2xs font-medium text-primary hover:underline"
                onClick={() => setExpanded((was) => !was)}
              >
                {expanded ? t('Show less') : t('Show more')}
              </button>
            ) : null}
          </>
        ) : (
          <p className="mt-0.5 text-2xs text-muted-foreground">{t('No description yet.')}</p>
        )}
      </div>
    </div>
  );
}
