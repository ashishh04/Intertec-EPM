import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Pause, Pencil, Play, RefreshCw, Repeat, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounce } from '@/hooks/useDebounce';
import {
  useCreateSeries,
  useGenerateSeries,
  useMoveSeries,
  useRecurrencePreview,
  useUpdateSeries,
  useWorkPackageSeries,
} from '@/hooks/useTaskSeries';
import { currentLanguage, intlLocale, t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import { cn, formatLongDate, formatNumber, formatShortDate, formatWeekdayDate, toISODateOnly } from '@/lib/utils';
import type {
  ID,
  NonWorkingDayPolicy,
  RecurrenceFrequency,
  RecurrenceRule,
  TaskSeriesDetail,
  TaskSeriesInput,
  TaskSeriesState,
} from '@/types';

/**
 * Recurring tasks on a task's page (BR-105 to BR-107): the rule dialog with a
 * live preview of the next dates, the Series card on a template — its rule in
 * words, state, next date, actions and the tasks it made — and "Part of a
 * series" on a task one of them made, linking back to its template.
 */

/** The task a series is made from, as the page has it. */
export interface SeriesTemplate {
  id: ID;
  subject: string;
  projectId: ID;
  startDate?: string;
  dueDate?: string;
}

const DAY_MS = 86_400_000;
const weekdayOf = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** A weekday's name in the reader's language: 1 Monday … 7 Sunday (1 January 2024 was a Monday). */
const weekdayName = (day: number, style: 'short' | 'long') =>
  new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, day)));
/** Dates in a row, separated as the reader's language separates them. */
const listed = (items: string[]) => items.join(currentLanguage() === 'ar' ? '، ' : ', ');

const STATE: Record<TaskSeriesState | 'finished', { readonly label: string; tone: Tone }> = {
  active: { get label() { return t('Active'); }, tone: 'success' },
  paused: { get label() { return t('Paused'); }, tone: 'warning' },
  cancelled: { get label() { return t('Cancelled'); }, tone: 'neutral' },
  finished: { get label() { return t('Finished'); }, tone: 'neutral' },
};

export function SeriesStateBadge({ series }: { series: Pick<TaskSeriesDetail, 'state' | 'nextOccurrence'> }) {
  const key = series.state === 'active' && !series.nextOccurrence ? 'finished' : series.state;
  return (
    <Badge tone={STATE[key].tone} dot>
      {STATE[key].label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* The rule dialog                                                            */
/* -------------------------------------------------------------------------- */

interface Draft {
  frequency: RecurrenceFrequency;
  interval: string;
  weekdays: number[];
  dayOfMonth: number | 'last';
  startDate: string;
  ends: 'never' | 'date' | 'count';
  endDate: string;
  count: string;
  nonWorkingDays: NonWorkingDayPolicy;
  leadDays: string;
  durationDays: string;
}

function initialDraft(task: SeriesTemplate, series?: TaskSeriesDetail): Draft {
  if (series) {
    const { rule } = series;
    return {
      frequency: rule.frequency,
      interval: String(rule.interval),
      weekdays: rule.weekdays?.length ? rule.weekdays : [weekdayOf(rule.startDate)],
      dayOfMonth: rule.dayOfMonth ?? Number(rule.startDate.slice(8)),
      startDate: rule.startDate,
      ends: rule.count !== undefined ? 'count' : rule.endDate ? 'date' : 'never',
      endDate: rule.endDate ?? '',
      count: String(rule.count ?? 10),
      nonWorkingDays: rule.nonWorkingDays ?? 'keep',
      leadDays: String(series.leadDays),
      durationDays: String(series.durationDays),
    };
  }
  const today = toISODateOnly(new Date());
  const start = task.startDate && task.startDate >= today ? task.startDate : today;
  const runs = task.startDate && task.dueDate ? Math.min(Math.max(daysBetween(task.startDate, task.dueDate), 0), 365) : 0;
  return {
    frequency: 'weekly',
    interval: '1',
    weekdays: [weekdayOf(start)],
    dayOfMonth: Number(start.slice(8)),
    startDate: start,
    ends: 'count',
    endDate: '',
    count: '10',
    nonWorkingDays: 'keep',
    leadDays: '7',
    durationDays: String(runs),
  };
}

/** The rule as the server takes it. What is not valid is the server's to say, in the preview. */
function toRule(draft: Draft): RecurrenceRule {
  const rule: RecurrenceRule = {
    frequency: draft.frequency,
    interval: draft.frequency === 'daily' ? 1 : Number(draft.interval || 0),
    startDate: draft.startDate,
    nonWorkingDays: draft.nonWorkingDays,
  };
  if (draft.frequency === 'weekly') rule.weekdays = draft.weekdays;
  if (draft.frequency === 'monthly' || draft.frequency === 'quarterly') rule.dayOfMonth = draft.dayOfMonth;
  if (draft.ends === 'date') rule.endDate = draft.endDate;
  if (draft.ends === 'count') rule.count = Number(draft.count || 0);
  return rule;
}

const days = (value: string) => {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= 0 && number <= 365 ? number : undefined;
};

/**
 * Makes a task recurring, or changes the series it is the template of. The
 * preview beside the rule is the server's own reading of it — the rule in
 * words and its next dates — so what is shown is what will be made.
 */
export function RecurrenceDialog({
  open,
  onOpenChange,
  task,
  series,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: SeriesTemplate;
  series?: TaskSeriesDetail;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(task, series));
  const create = useCreateSeries(task.id);
  const update = useUpdateSeries(series?.id ?? '');
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  // Each time it opens, it starts from the task or the series as they are now.
  useEffect(() => {
    if (open) setDraft(initialDraft(task, series));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rule = useMemo(() => toRule(draft), [draft]);
  const asked = useDebounce(rule, 300);
  const preview = useRecurrencePreview(open ? asked : undefined);
  const leadDays = days(draft.leadDays);
  const durationDays = days(draft.durationDays);
  const today = toISODateOnly(new Date());
  const pending = create.isPending || update.isPending;
  const ready = Boolean(preview.data && !preview.data.problem && !preview.isPlaceholderData) && leadDays !== undefined && durationDays !== undefined;

  const unit = (count: number) => {
    switch (draft.frequency) {
      case 'weekly':
        return t('{count, plural, one {week} other {weeks}}', { count });
      case 'monthly':
        return t('{count, plural, one {month} other {months}}', { count });
      case 'quarterly':
        return t('{count, plural, one {quarter} other {quarters}}', { count });
      default:
        return t('{count, plural, one {day} other {days}}', { count });
    }
  };

  const save = () => {
    if (leadDays === undefined || durationDays === undefined) return;
    const input: TaskSeriesInput = { rule, leadDays, durationDays };
    const done = {
      onSuccess: (saved: TaskSeriesDetail) => {
        toast.success(series ? t('Series changed') : t('The task now repeats'), { description: saved.ruleText });
        onOpenChange(false);
      },
      onError: (error: Error) => toast.error(t('The series could not be saved'), { description: error.message }),
    };
    if (series) update.mutate(input, done);
    else create.mutate(input, done);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{series ? t('Change the series') : t('Make recurring')}</DialogTitle>
          <DialogDescription>
            {series
              ? t('Tasks already made stay as they are; the new rule applies from today.')
              : t('Each occurrence gets its own task, copied from this one: type, description and checklist, priority, people, category, version and custom fields.')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-4">
            <section className="space-y-3">
              <p className="text-xs font-semibold">{t('Repeats')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-frequency">{t('How often')}</Label>
                  <Select
                    value={draft.frequency}
                    onValueChange={(value) => set({ frequency: value as RecurrenceFrequency, interval: value === 'custom' && draft.interval === '1' ? '2' : draft.interval })}
                  >
                    <SelectTrigger id="recurrence-frequency" className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">{t('Daily')}</SelectItem>
                      <SelectItem value="weekly">{t('Weekly')}</SelectItem>
                      <SelectItem value="monthly">{t('Monthly')}</SelectItem>
                      <SelectItem value="quarterly">{t('Quarterly')}</SelectItem>
                      <SelectItem value="custom">{t('Every few days')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.frequency !== 'daily' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="recurrence-interval">{t('Every')}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="recurrence-interval"
                        type="number"
                        min={1}
                        className="h-9 w-20 text-xs"
                        value={draft.interval}
                        onChange={(event) => set({ interval: event.target.value })}
                      />
                      <span className="text-xs text-muted-foreground">{unit(Number(draft.interval) || 1)}</span>
                    </div>
                  </div>
                ) : null}
              </div>

              {draft.frequency === 'weekly' ? (
                <div className="space-y-1.5">
                  <Label>{t('On these days')}</Label>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('On these days')}>
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                      const on = draft.weekdays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={on}
                          title={weekdayName(day, 'long')}
                          onClick={() =>
                            set({ weekdays: on ? draft.weekdays.filter((one) => one !== day) : [...draft.weekdays, day].sort((a, b) => a - b) })
                          }
                          className={cn(
                            'h-8 min-w-11 rounded-full border px-2.5 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            on ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border bg-surface text-muted-foreground hover:border-primary/25',
                          )}
                        >
                          {weekdayName(day, 'short')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {draft.frequency === 'monthly' || draft.frequency === 'quarterly' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-day">{t('On day')}</Label>
                  <Select
                    value={String(draft.dayOfMonth)}
                    onValueChange={(value) => set({ dayOfMonth: value === 'last' ? 'last' : Number(value) })}
                  >
                    <SelectTrigger id="recurrence-day" className="h-9 w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }, (_, index) => (
                        <SelectItem key={index + 1} value={String(index + 1)}>
                          {formatNumber(index + 1)}
                        </SelectItem>
                      ))}
                      <SelectItem value="last">{t('The last day')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {typeof draft.dayOfMonth === 'number' && draft.dayOfMonth > 28 ? (
                    <FieldHint>{t('In a month without that day, it falls on the month’s last day.')}</FieldHint>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-start">{t('Starts')}</Label>
                  <Input
                    id="recurrence-start"
                    type="date"
                    className="h-9 text-xs"
                    value={draft.startDate}
                    onChange={(event) => set({ startDate: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-ends">{t('Ends')}</Label>
                  <div className="flex items-center gap-2">
                    <Select value={draft.ends} onValueChange={(value) => set({ ends: value as Draft['ends'] })}>
                      <SelectTrigger id="recurrence-ends" className="h-9 min-w-0 flex-1 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">{t('Never')}</SelectItem>
                        <SelectItem value="date">{t('On a date')}</SelectItem>
                        <SelectItem value="count">{t('After a number of times')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {draft.ends === 'date' ? (
                      <Input
                        type="date"
                        aria-label={t('End date')}
                        className="h-9 w-36 text-xs"
                        value={draft.endDate}
                        min={draft.startDate}
                        onChange={(event) => set({ endDate: event.target.value })}
                      />
                    ) : draft.ends === 'count' ? (
                      <Input
                        type="number"
                        min={1}
                        aria-label={t('Number of times')}
                        className="h-9 w-20 text-xs"
                        value={draft.count}
                        onChange={(event) => set({ count: event.target.value })}
                      />
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="recurrence-days-off">{t('On a non-working day')}</Label>
                <Select value={draft.nonWorkingDays} onValueChange={(value) => set({ nonWorkingDays: value as NonWorkingDayPolicy })}>
                  <SelectTrigger id="recurrence-days-off" className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep">{t('Keep the day')}</SelectItem>
                    <SelectItem value="skip">{t('Leave it out')}</SelectItem>
                    <SelectItem value="next">{t('Move it to the next working day')}</SelectItem>
                  </SelectContent>
                </Select>
                <FieldHint>{t('Working days are the instance’s calendar: its working week and its holidays.')}</FieldHint>
              </div>
            </section>

            <section className="space-y-3">
              <p className="text-xs font-semibold">{t('Each task')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-lead">{t('Made this many days ahead')}</Label>
                  <Input
                    id="recurrence-lead"
                    type="number"
                    min={0}
                    max={365}
                    className="h-9 w-24 text-xs"
                    value={draft.leadDays}
                    invalid={leadDays === undefined}
                    onChange={(event) => set({ leadDays: event.target.value })}
                  />
                  <FieldHint>{t('0 makes each task on its day. Tasks already within reach are made straight away.')}</FieldHint>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-duration">{t('Runs for this many days')}</Label>
                  <Input
                    id="recurrence-duration"
                    type="number"
                    min={0}
                    max={365}
                    className="h-9 w-24 text-xs"
                    value={draft.durationDays}
                    invalid={durationDays === undefined}
                    onChange={(event) => set({ durationDays: event.target.value })}
                  />
                  <FieldHint>{t('From its start to its due date; 0 means due the same day.')}</FieldHint>
                </div>
              </div>
            </section>
          </div>

          <aside className="space-y-2 rounded-lg border border-border bg-muted/40 p-3" aria-live="polite">
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              {t('Preview')}
              {preview.isFetching ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden /> : null}
            </p>
            {!preview.data ? (
              <Skeleton className="h-32 w-full" />
            ) : preview.data.problem ? (
              <p className="flex items-start gap-1.5 text-2xs text-danger">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                {preview.data.problem}
              </p>
            ) : (
              <>
                <p className="text-xs text-foreground" dir="auto">
                  {preview.data.ruleText}
                </p>
                <p className="text-2xs text-muted-foreground">{t('The next dates:')}</p>
                <ol className="space-y-0.5 text-2xs text-foreground">
                  {preview.data.dates.map((date) => (
                    <li key={date}>{formatWeekdayDate(date)}</li>
                  ))}
                </ol>
                <p className="text-2xs text-muted-foreground">
                  {preview.data.total === null
                    ? t('It does not end.')
                    : t('{total, plural, one {# occurrence} other {# occurrences}} in all, the last on {date}.', {
                        total: preview.data.total,
                        date: formatLongDate(preview.data.last),
                      })}
                </p>
                {draft.startDate && draft.startDate < today ? (
                  <p className="text-2xs text-muted-foreground">{t('Occurrences before today are not made.')}</p>
                ) : null}
              </>
            )}
          </aside>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} disabled={!ready} loading={pending}>
            {series ? t('Save changes') : t('Make recurring')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* On the task's page                                                         */
/* -------------------------------------------------------------------------- */

/** The Series card on a template, or "Part of a series" on a task one made. Nothing on any other task. */
export function TaskSeriesPanel({ task }: { task: SeriesTemplate }) {
  const link = useWorkPackageSeries(task.id);
  const series = link.data?.series;
  if (!link.data || link.data.role === 'none' || !series) return null;
  if (link.data.role === 'instance') return <InstanceCard series={series} occurrence={link.data.occurrence} />;
  return <SeriesCard series={series} task={task} />;
}

const SHOWN = 6;

function SeriesCard({ series, task }: { series: TaskSeriesDetail; task: SeriesTemplate }) {
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const move = useMoveSeries(series.id);
  const generate = useGenerateSeries(series.id);
  const today = toISODateOnly(new Date());
  const live = series.state !== 'cancelled';
  const editable = series.canEdit && live;
  const shown = showAll ? series.instances : series.instances.slice(0, SHOWN);

  const act = (what: 'pause' | 'resume' | 'cancel') =>
    move.mutate(what, {
      onSuccess: () => {
        toast.success(what === 'pause' ? t('Series paused') : what === 'resume' ? t('Series resumed') : t('Series cancelled'));
        setCancelling(false);
      },
      onError: (error) => toast.error(t('That could not be done'), { description: error.message }),
    });

  const makeDue = () =>
    generate.mutate(undefined, {
      onSuccess: (result) =>
        result.generated > 0
          ? toast.success(t('{count, plural, one {# task made} other {# tasks made}}', { count: result.generated }))
          : toast(t('Nothing was due'), { description: result.notes[0] }),
      onError: (error) => toast.error(t('That could not be done'), { description: error.message }),
    });

  return (
    <Card data-testid="task-series">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Recurring')}
        </CardTitle>
        <SeriesStateBadge series={series} />
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground" dir="auto">
            {series.ruleText}
          </p>
          <p className="text-2xs text-muted-foreground">
            {t(
              'Each task is made {lead, plural, =0 {on its day} one {# day ahead} other {# days ahead}} and runs {duration, plural, =0 {for the day} one {for # day} other {for # days}}.',
              { lead: series.leadDays, duration: series.durationDays },
            )}
          </p>
          <p className="text-2xs text-muted-foreground">
            {series.state === 'cancelled'
              ? t('Cancelled {date}. No more tasks will be made; those it made stay, linked to this one.', {
                  date: formatLongDate(series.cancelledAt),
                })
              : series.state === 'paused'
                ? t('Paused. Occurrences that pass while it is paused are not made when it resumes.')
                : series.nextOccurrence
                  ? t('Next: {date}. {due, select, now {Its task is made at the next run.} other {Its task is made on {made}.}}', {
                      date: formatLongDate(series.nextOccurrence),
                      due: !series.nextGenerationOn || series.nextGenerationOn <= today ? 'now' : 'later',
                      made: formatLongDate(series.nextGenerationOn),
                    })
                  : t('Finished: every occurrence has its task.')}
          </p>
          {series.problem ? (
            <p className="flex items-start gap-1.5 text-2xs text-warning-strong">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {series.problem}
            </p>
          ) : null}
        </div>

        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              {t('Change')}
            </Button>
            {series.state === 'active' ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => act('pause')} loading={move.isPending && move.variables === 'pause'}>
                  <Pause className="h-3.5 w-3.5" />
                  {t('Pause')}
                </Button>
                <Button variant="ghost" size="sm" onClick={makeDue} loading={generate.isPending}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('Make due tasks now')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => act('resume')} loading={move.isPending && move.variables === 'resume'}>
                <Play className="h-3.5 w-3.5" />
                {t('Resume')}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setCancelling(true)}>
              <XCircle className="h-3.5 w-3.5" />
              {t('Cancel the series')}
            </Button>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p className="epm-eyebrow">{t('Tasks it made ({count, number})', { count: series.instanceCount })}</p>
          {series.instances.length === 0 ? (
            <p className="text-2xs text-muted-foreground">{t('None yet.')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {shown.map((instance) => (
                <li key={instance.occurrence} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                  <span className="w-24 shrink-0 font-mono text-2xs text-muted-foreground">{formatLongDate(instance.occurrence)}</span>
                  {instance.task ? (
                    <Link to={`/tasks/${instance.task.id}`} dir="auto" className="min-w-0 flex-1 truncate text-foreground hover:underline">
                      <span className="font-mono text-2xs text-muted-foreground">{instance.task.key}</span> {instance.task.subject}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 text-2xs text-muted-foreground">
                      {instance.workPackageId ? t('Deleted, or out of your reach') : t('Being made…')}
                    </span>
                  )}
                  {instance.task ? (
                    <Badge size="sm" tone={instance.task.closed ? 'success' : 'neutral'}>
                      {instance.task.status}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {series.instances.length > SHOWN ? (
            <Button variant="link" size="sm" className="h-auto px-0 text-2xs" onClick={() => setShowAll((value) => !value)}>
              {showAll ? t('Show fewer') : t('Show all {count, number}', { count: series.instances.length })}
            </Button>
          ) : null}
          {live && series.upcoming.length > 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t('Still to come: {dates}', { dates: listed(series.upcoming.map((date) => formatShortDate(date))) })}
            </p>
          ) : null}
        </div>
      </CardContent>

      <RecurrenceDialog open={editing} onOpenChange={setEditing} task={task} series={series} />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        tone="danger"
        title={t('Cancel this series?')}
        description={t(
          'No more tasks will be made. The {count, plural, one {# task} other {# tasks}} it made stay, linked to this one. A cancelled series cannot be resumed.',
          { count: series.instanceCount },
        )}
        confirmLabel={t('Cancel the series')}
        cancelLabel={t('Keep it')}
        pending={move.isPending}
        onConfirm={() => act('cancel')}
      />
    </Card>
  );
}

function InstanceCard({ series, occurrence }: { series: TaskSeriesDetail; occurrence?: string }) {
  return (
    <Card data-testid="task-series-instance">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Part of a series')}
        </CardTitle>
        <SeriesStateBadge series={series} />
      </CardHeader>
      <CardContent className="space-y-1.5 pt-4">
        <p className="text-2xs text-muted-foreground">
          {t('Made for {date}, from its template:', { date: formatLongDate(occurrence) })}
        </p>
        <Link to={`/tasks/${series.templateWorkPackageId}`} dir="auto" className="block text-xs font-medium text-primary hover:underline">
          {series.templateSubject ?? `#${series.templateWorkPackageId}`}
        </Link>
        <p className="text-2xs text-muted-foreground" dir="auto">
          {series.ruleText}
        </p>
        <p className="text-2xs text-muted-foreground">
          {t('{count, plural, one {# task} other {# tasks}} in the series so far.', { count: series.instanceCount })}
        </p>
      </CardContent>
    </Card>
  );
}
