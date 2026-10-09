import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { PersonPicker } from '@/components/automation/PersonPicker';
import { ComboSelect } from '@/components/common/ComboSelect';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSkeleton, TableCard, TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ScopePicker } from '@/components/insights/ScopePicker';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useApproveReportSchedule,
  useDeleteReportSchedule,
  useReportRun,
  useReportRuns,
  useReportScheduleOptions,
  useReportSchedules,
  useRunReportSchedule,
  useSaveReportSchedule,
} from '@/hooks/useScheduledReports';
import { useTimezones, useUserMap } from '@/hooks/useUsers';
import { saveBlob } from '@/lib/download';
import { PERIODS } from '@/lib/report-periods';
import type { Tone } from '@/lib/domain';
import { formatBytes, formatDateTime, formatRelative, formatShortDate } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { scheduledReportService } from '@/services';
import { ApiError } from '@/services/api/client';
import type {
  ID,
  ReportDelivery,
  ReportFormat,
  ReportPeriodPreset,
  ReportRun,
  ReportRunStatus,
  ReportSchedule,
  ReportScheduleInput,
  ReportScheduleOptions,
} from '@/types';

/**
 * Scheduled reports (BRQ-08: BR-207 to BR-210).
 *
 * A dashboard or a saved view, sent as a PDF and an Excel workbook on a
 * timetable. Each recipient's copy is built with their own access, so a
 * project they cannot see is left out of theirs and the email says how many
 * were. Outside addresses get a copy only once someone other than whoever
 * added them has approved them. Every run, every copy and every email's fate
 * is in the log, by report and by date, with the files as they were sent.
 */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const FORMAT_LABEL: Record<ReportFormat, string> = { pdf: 'PDF', xlsx: 'Excel' };

const RUN_STATUS: Record<ReportRunStatus, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'primary' },
  rendered: { label: 'Rendered', tone: 'success' },
  missed: { label: 'Missed', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

const DELIVERY_STATE: Record<ReportRun['deliveryState'], { label: string; tone: Tone }> = {
  delivered: { label: 'Delivered', tone: 'success' },
  partial: { label: 'Partly delivered', tone: 'warning' },
  pending: { label: 'Sending', tone: 'primary' },
  failed: { label: 'Not delivered', tone: 'danger' },
  none: { label: 'Nothing sent', tone: 'neutral' },
};

const EMAIL_STATUS: Record<ReportDelivery['emailStatus'], { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'primary' },
  sending: { label: 'Sending', tone: 'primary' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  withheld: { label: 'Not sent', tone: 'neutral' },
  none: { label: 'Not queued', tone: 'neutral' },
};

// Browsers report some zones by their old names; the instance lists the current ones.
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
};

/** The person's own time zone, else the browser's. */
const defaultZone = (profileZone?: string) => {
  if (profileZone) return profileZone;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return ZONE_ALIASES[zone] ?? zone;
  } catch {
    return 'UTC';
  }
};

function blankSchedule(timezone: string, prefill?: { dashboard?: string; scope?: string; title?: string }): ReportScheduleInput {
  return {
    name: prefill?.title ? `${prefill.title} — weekly` : '',
    description: '',
    active: true,
    sourceKind: 'dashboard',
    sourceId: prefill?.dashboard ?? 'portfolio-health',
    scope: prefill?.scope ?? 'instance',
    periodPreset: 'previous-week',
    frequency: 'weekly',
    weekday: 1,
    dayOfMonth: null,
    timeOfDay: '07:00',
    timezone,
    windowMinutes: 120,
    formats: ['pdf', 'xlsx'],
    recipientUserIds: [],
    externalEmails: [],
  };
}

const toInput = (schedule: ReportSchedule): ReportScheduleInput => ({
  name: schedule.name,
  description: schedule.description ?? '',
  active: schedule.active,
  sourceKind: schedule.sourceKind,
  sourceId: schedule.sourceId,
  scope: schedule.scope,
  periodPreset: schedule.periodPreset,
  frequency: schedule.frequency,
  weekday: schedule.weekday,
  dayOfMonth: schedule.dayOfMonth,
  timeOfDay: schedule.timeOfDay,
  timezone: schedule.timezone,
  windowMinutes: schedule.windowMinutes,
  formats: schedule.formats,
  recipientUserIds: schedule.recipientUserIds,
  externalEmails: schedule.externalEmails,
});

const describeError = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong';

export default function ScheduledReportsPage() {
  const { can, user } = useAuth();
  const allowed = can('reports:schedule');
  const schedules = useReportSchedules(allowed);
  const options = useReportScheduleOptions(allowed);
  const save = useSaveReportSchedule();
  const [search, setSearch] = useSearchParams();
  const [editing, setEditing] = useState<{ id?: ID; input: ReportScheduleInput }>();
  const [logFor, setLogFor] = useState<ID | undefined>(search.get('schedule') ?? undefined);
  const zone = defaultZone(user?.timezone);

  // "Schedule" on a dashboard opens here with the dashboard and its scope chosen.
  useEffect(() => {
    if (search.get('new') !== '1' || !options.data) return;
    const dashboard = search.get('dashboard') ?? undefined;
    const title = options.data.dashboards.find((entry) => entry.id === dashboard)?.title;
    setEditing({ input: blankSchedule(zone, { dashboard: title ? dashboard : undefined, scope: search.get('scope') ?? undefined, title }) });
    const next = new URLSearchParams(search);
    ['new', 'dashboard', 'scope'].forEach((key) => next.delete(key));
    setSearch(next, { replace: true });
  }, [search, setSearch, options.data, zone]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Insights"
        title="Scheduled reports"
        description="Dashboards and saved views, sent as a PDF and an Excel workbook on a timetable. Each person's copy is built with their own access."
        actions={
          <Button size="sm" onClick={() => setEditing({ input: blankSchedule(zone) })} disabled={!options.data}>
            <Plus className="h-3.5 w-3.5" />
            New schedule
          </Button>
        }
      />

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Schedules</CardTitle>
          <CardDescription>What is sent, when, and to whom.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={schedules.isLoading}
            isError={schedules.isError}
            error={schedules.error}
            onRetry={() => schedules.refetch()}
            errorTitle="Unable to load the schedules"
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(schedules.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={CalendarClock}
                title="Nothing is scheduled yet"
                description="Send a dashboard every Monday morning, or a saved view at the end of each month."
                action={options.data ? { label: 'New schedule', onClick: () => setEditing({ input: blankSchedule(zone) }) } : undefined}
              />
            }
          >
            <ul className="divide-y divide-border">
              {(schedules.data ?? []).map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  myId={user?.id}
                  canApprove={can('reports:approve')}
                  onEdit={() => setEditing({ id: schedule.id, input: toInput(schedule) })}
                  onLog={() => {
                    setLogFor(schedule.id);
                    // The log sits below the list; bring it into view with the report chosen.
                    requestAnimationFrame(() => document.getElementById('run-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                  }}
                />
              ))}
            </ul>
          </QueryBoundary>
        </CardContent>
      </Card>

      <RunLog schedules={schedules.data ?? []} scheduleId={logFor} onSchedule={setLogFor} />

      {editing && options.data ? (
        <ScheduleEditor
          id={editing.id}
          initial={editing.input}
          options={options.data}
          saving={save.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(input) =>
            save.mutate(
              { id: editing.id, input },
              {
                onSuccess: (saved) => {
                  toast.success(editing.id ? 'Schedule saved' : 'Schedule created', {
                    description: saved.nextRunAt ? `Next sent ${formatDateTime(saved.nextRunAt)}.` : 'It is switched off.',
                  });
                  setEditing(undefined);
                },
                onError: (error) => toast.error('The schedule was not saved', { description: describeError(error) }),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function ScheduleRow({
  schedule,
  myId,
  canApprove,
  onEdit,
  onLog,
}: {
  schedule: ReportSchedule;
  myId?: ID;
  canApprove: boolean;
  onEdit: () => void;
  onLog: () => void;
}) {
  const run = useRunReportSchedule();
  const approve = useApproveReportSchedule();
  const remove = useDeleteReportSchedule();
  const [confirming, setConfirming] = useState(false);
  const approval = schedule.externalApproval;
  const awaiting = approval.required && !approval.approved;
  const people = schedule.recipientUserIds.length;
  const outside = schedule.externalEmails.length;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {schedule.name}
          <Badge tone={schedule.active ? 'success' : 'neutral'} size="sm">
            {schedule.active ? 'On' : 'Off'}
          </Badge>
          {approval.required ? (
            <Badge tone={awaiting ? 'warning' : 'success'} size="sm" dot>
              {awaiting ? 'External recipients awaiting approval' : 'External recipients approved'}
            </Badge>
          ) : null}
          {schedule.lastRunStatus ? (
            <Badge tone={RUN_STATUS[schedule.lastRunStatus].tone} size="sm">
              Last run {RUN_STATUS[schedule.lastRunStatus].label.toLowerCase()}
            </Badge>
          ) : null}
        </p>
        <p className="text-2xs text-muted-foreground">
          {schedule.sourceLabel} · {PERIODS.find((period) => period.id === schedule.periodPreset)?.label} ·{' '}
          {schedule.formats.map((format) => FORMAT_LABEL[format]).join(' and ')}
        </p>
        <p className="text-2xs text-muted-foreground">
          {schedule.describedTiming} · {people} {people === 1 ? 'person' : 'people'}
          {outside > 0 ? ` and ${outside} external ${outside === 1 ? 'address' : 'addresses'}` : ''}
          {schedule.nextRunAt ? ` · next ${formatDateTime(schedule.nextRunAt)}` : ''}
          {schedule.lastRunAt ? ` · last ${formatRelative(schedule.lastRunAt)}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {awaiting && canApprove && approval.setBy !== myId ? (
          <Button
            size="sm"
            variant="outline"
            loading={approve.isPending}
            onClick={() =>
              approve.mutate(schedule.id, {
                onSuccess: () => toast.success('External recipients approved'),
                onError: (error) => toast.error('Not approved', { description: describeError(error) }),
              })
            }
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Approve recipients
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          loading={run.isPending}
          onClick={() =>
            run.mutate(schedule.id, {
              onSuccess: (result) => {
                const queued = (result.deliveries ?? []).filter((delivery) =>
                  ['queued', 'sending', 'sent'].includes(delivery.emailStatus),
                ).length;
                const notSent = result.recipients - queued;
                toast.success('Report sent to the outbox', {
                  description: `${queued} of ${result.recipients} ${result.recipients === 1 ? 'copy' : 'copies'} queued${notSent > 0 ? `, ${notSent} not sent — see the log` : ''}.`,
                });
                onLog();
              },
              onError: (error) => toast.error('It did not run', { description: describeError(error) }),
            })
          }
        >
          <Play className="h-3.5 w-3.5" />
          Run now
        </Button>
        <Button size="sm" variant="secondary" onClick={onLog}>
          <History className="h-3.5 w-3.5" />
          Log
        </Button>
        <Button size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Delete ${schedule.name}`} onClick={() => setConfirming(true)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete "${schedule.name}"?`}
        description={
          schedule.lastRunAt
            ? 'It has run, so it is switched off rather than deleted: its log and files stay for the records policy.'
            : 'It has never run, so nothing else is lost.'
        }
        confirmLabel={schedule.lastRunAt ? 'Switch off' : 'Delete'}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(schedule.id, {
            onSuccess: (result) => {
              toast.success(result.outcome === 'deleted' ? 'Schedule deleted' : 'Schedule switched off; its log is kept');
              setConfirming(false);
            },
            onError: (error) => toast.error('It could not be deleted', { description: describeError(error) }),
          })
        }
      />
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The editor                                                                 */
/* -------------------------------------------------------------------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const splitAddresses = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((one) => one.trim().toLowerCase())
    .filter(Boolean);

function problemsOf(draft: ReportScheduleInput, addresses: string[]): string[] {
  const found: string[] = [];
  if (!draft.name.trim()) found.push('Give the schedule a name.');
  if (!draft.sourceId) found.push(draft.sourceKind === 'view' ? 'Choose a saved view.' : 'Choose a dashboard.');
  if (draft.frequency === 'weekly' && !draft.weekday) found.push('Choose the day of the week.');
  if (draft.frequency === 'monthly' && (draft.dayOfMonth === null || draft.dayOfMonth === undefined)) {
    found.push('Choose the day of the month.');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) found.push('The time is HH:MM, e.g. 07:00.');
  if (!Number.isInteger(draft.windowMinutes) || draft.windowMinutes < 5 || draft.windowMinutes > 1440) {
    found.push('The window is from 5 minutes to 24 hours.');
  }
  if (draft.formats.length === 0) found.push('Choose at least one format.');
  const bad = addresses.filter((address) => !EMAIL.test(address));
  if (bad.length > 0) found.push(`Not email addresses: ${bad.join(', ')}.`);
  if (draft.recipientUserIds.length + addresses.length === 0) found.push('Add at least one recipient.');
  return found;
}

function describeTiming(draft: ReportScheduleInput): string {
  const at = `at ${draft.timeOfDay} (${draft.timezone})`;
  if (draft.frequency === 'daily') return `Every day ${at}`;
  if (draft.frequency === 'weekly') return `Every ${WEEKDAYS[(draft.weekday ?? 1) - 1]} ${at}`;
  if (draft.dayOfMonth === 0) return `On the last day of each month ${at}`;
  return `On day ${draft.dayOfMonth ?? 1} of each month ${at}`;
}

function ScheduleEditor({
  id,
  initial,
  options,
  saving,
  onClose,
  onSave,
}: {
  id?: ID;
  initial: ReportScheduleInput;
  options: ReportScheduleOptions;
  saving: boolean;
  onClose: () => void;
  onSave: (input: ReportScheduleInput) => void;
}) {
  const [draft, setDraft] = useState<ReportScheduleInput>(initial);
  const [addressText, setAddressText] = useState(initial.externalEmails.join('\n'));
  const set = (patch: Partial<ReportScheduleInput>) => setDraft((was) => ({ ...was, ...patch }));
  const addresses = useMemo(() => [...new Set(splitAddresses(addressText))], [addressText]);
  const problems = useMemo(() => problemsOf(draft, addresses), [draft, addresses]);
  const zones = useTimezones();
  const zoneOptions = useMemo(() => {
    const list = zones.data ?? [];
    const all = list.includes(draft.timezone) ? list : [draft.timezone, ...list];
    return (all.includes('UTC') ? all : ['UTC', ...all]).map((zone) => ({ id: zone, name: zone }));
  }, [zones.data, draft.timezone]);
  const addressesChanged = addresses.join('\n') !== [...initial.externalEmails].join('\n');

  const toggleFormat = (format: ReportFormat, on: boolean) =>
    set({ formats: on ? [...new Set([...draft.formats, format])] : draft.formats.filter((one) => one !== format) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{id ? 'Edit scheduled report' : 'New scheduled report'}</DialogTitle>
          <DialogDescription>
            Each recipient gets their own copy, built with their access. A project they cannot see is left out of theirs.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-name" required>
                Name
              </Label>
              <Input
                id="schedule-name"
                value={draft.name}
                maxLength={120}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="e.g. Weekly portfolio health"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Report on</Label>
              <Select
                value={draft.sourceKind}
                onValueChange={(value) =>
                  set(
                    value === 'view'
                      ? { sourceKind: 'view', sourceId: options.views[0]?.id ?? '', scope: 'instance' }
                      : { sourceKind: 'dashboard', sourceId: 'portfolio-health' },
                  )
                }
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dashboard">A dashboard</SelectItem>
                  <SelectItem value="view">A saved view of work packages</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-description">Description</Label>
            <Textarea
              id="schedule-description"
              rows={2}
              maxLength={1000}
              value={draft.description ?? ''}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>

          {draft.sourceKind === 'dashboard' ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Dashboard</Label>
                <Select value={draft.sourceId} onValueChange={(sourceId) => set({ sourceId })}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.dashboards.map((dashboard) => (
                      <SelectItem key={dashboard.id} value={dashboard.id}>
                        {dashboard.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ScopePicker id="schedule-scope" scope={draft.scope} onChange={(scope) => set({ scope })} triggerClassName="h-9 text-xs" />
              <div className="space-y-1.5">
                <Label>Period</Label>
                <Select value={draft.periodPreset} onValueChange={(value) => set({ periodPreset: value as ReportPeriodPreset })}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIODS.map((period) => (
                      <SelectItem key={period.id} value={period.id}>
                        {period.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldHint>Counted back from the day it is sent.</FieldHint>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="schedule-view">Saved view</Label>
              <ComboSelect
                id="schedule-view"
                label="Saved view"
                options={options.views}
                value={draft.sourceId || undefined}
                onChange={(sourceId) => set({ sourceId: sourceId ?? '' })}
                placeholder="Choose a saved view…"
                emptyLabel="No saved views"
              />
              <FieldHint>The work packages the view selects when it is sent, as each recipient may see them.</FieldHint>
            </div>
          )}

          <section className="space-y-2">
            <p className="text-xs font-semibold">When</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label>Every</Label>
                <Select
                  value={draft.frequency}
                  onValueChange={(value) =>
                    set({
                      frequency: value as ReportScheduleInput['frequency'],
                      weekday: value === 'weekly' ? (draft.weekday ?? 1) : null,
                      dayOfMonth: value === 'monthly' ? (draft.dayOfMonth ?? 1) : null,
                    })
                  }
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Day</SelectItem>
                    <SelectItem value="weekly">Week</SelectItem>
                    <SelectItem value="monthly">Month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.frequency === 'weekly' ? (
                <div className="space-y-1.5">
                  <Label>On</Label>
                  <Select value={String(draft.weekday ?? 1)} onValueChange={(value) => set({ weekday: Number(value) })}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((day, index) => (
                        <SelectItem key={day} value={String(index + 1)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {draft.frequency === 'monthly' ? (
                <div className="space-y-1.5">
                  <Label>On day</Label>
                  <Select value={String(draft.dayOfMonth ?? 1)} onValueChange={(value) => set({ dayOfMonth: Number(value) })}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, index) => (
                        <SelectItem key={index + 1} value={String(index + 1)}>
                          {index + 1}
                        </SelectItem>
                      ))}
                      <SelectItem value="0">The last day</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-time">At</Label>
                <Input
                  id="schedule-time"
                  type="time"
                  step={60}
                  className="h-9 text-xs"
                  value={draft.timeOfDay}
                  onChange={(event) => set({ timeOfDay: event.target.value.slice(0, 5) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-zone">Time zone</Label>
                <ComboSelect
                  id="schedule-zone"
                  label="Time zone"
                  options={zoneOptions}
                  value={draft.timezone}
                  onChange={(timezone) => set({ timezone: timezone ?? 'UTC' })}
                  loading={zones.isLoading}
                />
              </div>
            </div>
            <FieldHint>
              {describeTiming(draft)}. If the server is down then, it is still sent up to{' '}
              <Input
                aria-label="Window in minutes"
                type="number"
                min={5}
                max={1440}
                className="inline-flex h-6 w-16 px-1.5 text-2xs"
                value={draft.windowMinutes}
                onChange={(event) => set({ windowMinutes: Number(event.target.value) })}
              />{' '}
              minutes late; after that the occurrence is logged as missed, not sent at the wrong time.
            </FieldHint>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold">Files</p>
            <div className="flex flex-wrap gap-5">
              {(['pdf', 'xlsx'] as ReportFormat[]).map((format) => (
                <label key={format} className="flex items-center gap-2 text-xs">
                  <Checkbox checked={draft.formats.includes(format)} onCheckedChange={(on) => toggleFormat(format, on === true)} />
                  {format === 'pdf' ? <FileText className="h-3.5 w-3.5 text-muted-foreground" /> : <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />}
                  {format === 'pdf' ? 'PDF' : 'Excel workbook'}
                </label>
              ))}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>People</Label>
              <PersonPicker
                kinds={['user']}
                value={draft.recipientUserIds.map((userId) => ({ kind: 'user' as const, userId }))}
                onChange={(people) =>
                  set({ recipientUserIds: people.flatMap((person) => (person.kind === 'user' ? [person.userId] : [])) })
                }
                emptyText="Nobody yet"
                label="Add a recipient"
              />
              <FieldHint>Each gets the report as they would see it in EPM.</FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-external">External addresses</Label>
              <Textarea
                id="schedule-external"
                rows={3}
                value={addressText}
                onChange={(event) => setAddressText(event.target.value)}
                placeholder="One per line"
              />
              <FieldHint>
                Sent only after someone other than you approves them{addressesChanged && id ? ' — changing them needs approving again' : ''}. Their copy
                is built with the report owner&rsquo;s access.
              </FieldHint>
            </div>
          </section>

          <label className="flex items-center gap-2 text-xs">
            <Switch checked={draft.active} onCheckedChange={(active) => set({ active })} aria-label="On" />
            On
          </label>

          {problems.length > 0 ? (
            <Alert tone="warning" title="Before it can be saved">
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={problems.length > 0}
            onClick={() =>
              onSave({
                ...draft,
                name: draft.name.trim(),
                description: draft.description?.trim() || null,
                externalEmails: addresses,
              })
            }
          >
            {id ? 'Save schedule' : 'Create schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* The log (BR-210)                                                           */
/* -------------------------------------------------------------------------- */

function RunLog({
  schedules,
  scheduleId,
  onSchedule,
}: {
  schedules: ReportSchedule[];
  scheduleId?: ID;
  onSchedule: (id?: ID) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [open, setOpen] = useState<ID>();
  const runs = useReportRuns(true, { scheduleId, from: from || undefined, to: to || undefined, page, pageSize });

  useEffect(() => setPage(1), [scheduleId, from, to, pageSize]);

  return (
    <Card id="run-log" className="scroll-mt-4">
      <CardHeader variant="compact">
        <CardTitle>Run log</CardTitle>
        <CardDescription>Every run, each recipient&rsquo;s copy and what became of its email — by report and by date.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-2">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Report</Label>
            <Select value={scheduleId ?? 'all'} onValueChange={(value) => onSchedule(value === 'all' ? undefined : value)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every report</SelectItem>
                {schedules.map((schedule) => (
                  <SelectItem key={schedule.id} value={schedule.id}>
                    {schedule.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="runs-from">From</Label>
            <Input id="runs-from" type="date" className="h-8 text-xs" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="runs-to">To</Label>
            <Input id="runs-to" type="date" className="h-8 text-xs" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>

        <QueryBoundary
          isLoading={runs.isLoading}
          isError={runs.isError}
          error={runs.error}
          onRetry={() => runs.refetch()}
          errorTitle="Unable to load the log"
          skeleton={<TableSkeleton columns={6} rows={4} />}
          isEmpty={(runs.data?.items ?? []).length === 0}
          empty={<EmptyState size="inline" icon={History} title="No runs here" description="Runs appear when a schedule is due, or is run by hand." />}
        >
          <TableCard
            footer={
              runs.data ? (
                <Pagination
                  page={runs.data.page}
                  pageSize={runs.data.pageSize}
                  total={runs.data.total}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                  pageSizeOptions={[15, 25, 50]}
                  itemLabel="run"
                />
              ) : null
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Report</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Delivery</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data?.items ?? []).map((run) => (
                  <TableRow key={run.id} className="cursor-pointer" onClick={() => setOpen(run.id)}>
                    <TableCell className="whitespace-nowrap text-xs" title={formatDateTime(run.startedAt)}>
                      {formatDateTime(run.startedAt)}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      <button type="button" className="text-left hover:underline" onClick={() => setOpen(run.id)}>
                        {run.scheduleName}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {run.scheduledFor ? formatDateTime(run.scheduledFor) : 'Run by hand'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {run.periodFrom && run.periodTo ? `${formatShortDate(run.periodFrom)} – ${formatShortDate(run.periodTo)}` : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge tone={RUN_STATUS[run.status].tone} size="sm">
                        {RUN_STATUS[run.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      <Badge tone={DELIVERY_STATE[run.deliveryState].tone} size="sm" dot>
                        {DELIVERY_STATE[run.deliveryState].label}
                      </Badge>
                      <span className="ml-2 text-2xs text-muted-foreground">
                        {run.delivered}/{run.recipients} sent{run.withheld > 0 ? ` · ${run.withheld} not sent` : ''}
                        {run.failed > 0 ? ` · ${run.failed} failed` : ''}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </QueryBoundary>
      </CardContent>
      <RunSheet runId={open} onClose={() => setOpen(undefined)} />
    </Card>
  );
}

function RunSheet({ runId, onClose }: { runId?: ID; onClose: () => void }) {
  const run = useReportRun(runId);
  const names = useUserMap();
  const data = run.data;

  return (
    <Sheet open={Boolean(runId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{data?.scheduleName ?? 'Run'}</SheetTitle>
          <SheetDescription>
            {data
              ? `${data.scheduledFor ? `Due ${formatDateTime(data.scheduledFor)}` : `Run by hand${data.triggeredBy ? ` by ${names.get(data.triggeredBy)?.name ?? 'someone'}` : ''}`} · started ${formatDateTime(data.startedAt)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>
        <div className="epm-scroll flex-1 space-y-4 overflow-y-auto p-5">
          <QueryBoundary
            isLoading={run.isLoading}
            isError={run.isError}
            error={run.error}
            onRetry={() => run.refetch()}
            errorTitle="Unable to load the run"
            skeleton={<ListSkeleton rows={3} />}
          >
            {data ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={RUN_STATUS[data.status].tone} size="sm">
                    {RUN_STATUS[data.status].label}
                  </Badge>
                  <Badge tone={DELIVERY_STATE[data.deliveryState].tone} size="sm" dot>
                    {DELIVERY_STATE[data.deliveryState].label}
                  </Badge>
                  {data.periodFrom && data.periodTo ? (
                    <span className="text-2xs text-muted-foreground">
                      Period {formatShortDate(data.periodFrom)} – {formatShortDate(data.periodTo)}
                    </span>
                  ) : null}
                </div>
                {data.error ? <Alert tone={data.status === 'missed' ? 'warning' : 'danger'}>{data.error}</Alert> : null}
                {(data.deliveries ?? []).length === 0 && !data.error ? (
                  <p className="text-xs text-muted-foreground">No copies were made in this run.</p>
                ) : null}
                <ul className="space-y-2">
                  {(data.deliveries ?? []).map((delivery) => (
                    <DeliveryItem
                      key={delivery.id}
                      runId={data.id}
                      delivery={delivery}
                      name={
                        delivery.recipientKind === 'user'
                          ? (names.get(delivery.recipientUserId ?? '')?.name ?? `Person ${delivery.recipientUserId}`)
                          : (delivery.recipientEmail ?? 'External')
                      }
                    />
                  ))}
                </ul>
              </>
            ) : null}
          </QueryBoundary>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeliveryItem({ runId, delivery, name }: { runId: ID; delivery: ReportDelivery; name: string }) {
  const [busy, setBusy] = useState<ID>();
  const email = EMAIL_STATUS[delivery.emailStatus];

  const download = async (artifact: ReportDelivery['artifacts'][number]) => {
    setBusy(artifact.id);
    try {
      saveBlob(await scheduledReportService.getFile(runId, artifact.id), artifact.filename);
    } catch (error) {
      toast.error('The file could not be downloaded', { description: describeError(error) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <li className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium">
          {name}
          {delivery.recipientKind === 'external' ? (
            <Badge tone="accent" size="sm">
              External
            </Badge>
          ) : null}
        </p>
        <Badge tone={email.tone} size="sm" dot>
          {email.label}
        </Badge>
      </div>
      {delivery.renderStatus === 'rendered' ? (
        <p className="text-2xs text-muted-foreground">
          <CheckCircle2 className="mr-1 inline h-3 w-3 text-success" aria-hidden />
          Covers {delivery.projectCount} {delivery.projectCount === 1 ? 'project' : 'projects'}
          {delivery.excludedProjects > 0
            ? ` — ${delivery.excludedProjects} in scope left out, outside ${delivery.recipientKind === 'user' ? 'their' : "the owner's"} access`
            : ''}
          {delivery.attempts > 0 ? ` · ${delivery.attempts} ${delivery.attempts === 1 ? 'attempt' : 'attempts'}` : ''}
          {delivery.sentAt ? ` · sent ${formatDateTime(delivery.sentAt)}` : ''}
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground">
          {delivery.renderStatus === 'failed' ? 'Could not be made: ' : 'Not sent: '}
          {delivery.reason ?? 'no reason recorded'}
        </p>
      )}
      {delivery.lastError ? <p className="text-2xs text-danger">Last error: {delivery.lastError}</p> : null}
      {delivery.artifacts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {delivery.artifacts.map((artifact) => (
            <Button key={artifact.id} size="sm" variant="secondary" loading={busy === artifact.id} onClick={() => void download(artifact)}>
              <Download className="h-3.5 w-3.5" />
              {FORMAT_LABEL[artifact.format]} · {formatBytes(artifact.size)}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

