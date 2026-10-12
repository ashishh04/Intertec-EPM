import { useMemo, useState } from 'react';
import { CalendarOff, CalendarRange, FileUp, Scale, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useAddTimeOff,
  useAvailability,
  useDeleteSchedule,
  useDeleteTimeOff,
  useImportHr,
  useReconcileHr,
  useResourceSettings,
  useSetSchedule,
} from '@/hooks/useResources';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { HrImportPerson, HrReconcileResult, TimeOffKind } from '@/types';
import { useAuth } from '@/providers/AuthProvider';
import { hours } from './bands';

const WEEKDAYS = [
  () => t('Mon'),
  () => t('Tue'),
  () => t('Wed'),
  () => t('Thu'),
  () => t('Fri'),
  () => t('Sat'),
  () => t('Sun'),
];

const KIND_LABEL: Record<TimeOffKind, () => string> = {
  leave: () => t('Leave'),
  sick: () => t('Sick'),
  training: () => t('Training'),
  other: () => t('Other'),
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Who is available when (BR-312): each person's work schedule — the hours of
 * each weekday at full time, times their employment fraction, from a date —
 * and their time off, with public holidays from the instance calendar. What
 * the HR source says is imported here, and checked against here.
 */
export function AvailabilityPanel({ initialPersonId }: { initialPersonId?: string }) {
  const { can, user } = useAuth();
  const manage = can('employees:manage');
  const users = useUsers();
  const [personId, setPersonId] = useState<string | undefined>(initialPersonId ?? (manage ? undefined : user?.id));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="w-72 space-y-1.5">
            <Label>{t('Person')}</Label>
            <ComboSelect
              label={t('Person')}
              placeholder={t('Choose a person')}
              value={personId}
              onChange={setPersonId}
              options={(users.data ?? []).map((entry) => ({ id: entry.id, name: entry.name, hint: entry.email }))}
            />
          </div>
        </CardContent>
      </Card>
      {personId ? <PersonAvailabilityView personId={personId} manage={manage} /> : null}
      {manage ? <HrTools /> : null}
    </div>
  );
}

function PersonAvailabilityView({ personId, manage }: { personId: string; manage: boolean }) {
  const availability = useAvailability(personId, undefined, 12);
  const removeSchedule = useDeleteSchedule(personId);
  const removeTimeOff = useDeleteTimeOff(personId);
  const [scheduling, setScheduling] = useState(false);
  const [addingOff, setAddingOff] = useState(false);
  const [deleting, setDeleting] = useState<{ kind: 'schedule' | 'time-off'; id: string } | null>(null);
  const data = availability.data;

  return (
    <QueryBoundary
      isLoading={availability.isLoading}
      isError={availability.isError}
      error={availability.error}
      onRetry={() => void availability.refetch()}
      errorTitle={t('This person’s availability could not be loaded')}
      skeleton={<ListSkeleton rows={6} />}
    >
      {data ? (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="availability">
          <Card>
            <CardHeader variant="compact">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <CalendarRange className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {t('Work schedule')}
                  </CardTitle>
                  <CardDescription>
                    {t('{hours} a week now. Each schedule holds from its date until the next.', { hours: hours(data.weeklyHours) })}
                  </CardDescription>
                </div>
                {manage ? (
                  <Button size="sm" variant="secondary" onClick={() => setScheduling(true)}>
                    {t('Set schedule')}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {data.schedules.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('No schedule: their weekly capacity is spread evenly over the instance’s working days.')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('From')}</TableHead>
                      {WEEKDAYS.map((day, index) => (
                        <TableHead key={index} numeric>
                          {day()}
                        </TableHead>
                      ))}
                      <TableHead numeric>{t('Fraction')}</TableHead>
                      <TableHead numeric>{t('A week')}</TableHead>
                      {manage ? <TableHead className="w-10" /> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.schedules.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">
                          {formatShortDate(row.effectiveFrom)}
                          {row.source === 'hr' ? (
                            <Badge tone="neutral" size="sm" className="ms-1.5">
                              HR
                            </Badge>
                          ) : null}
                        </TableCell>
                        {row.hours.map((value, index) => (
                          <TableCell key={index} numeric>
                            {value}
                          </TableCell>
                        ))}
                        <TableCell numeric>{row.fraction}</TableCell>
                        <TableCell numeric>{hours(row.weeklyHours)}</TableCell>
                        {manage ? (
                          <TableCell>
                            <Button variant="ghost" size="icon-sm" aria-label={t('Remove this schedule')} onClick={() => setDeleting({ kind: 'schedule', id: row.id })}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader variant="compact">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <CalendarOff className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {t('Time off')}
                  </CardTitle>
                  <CardDescription>{t('Whole days, or some hours of each day. Public holidays come from the instance calendar.')}</CardDescription>
                </div>
                {manage ? (
                  <Button size="sm" variant="secondary" onClick={() => setAddingOff(true)}>
                    {t('Add time off')}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {data.timeOff.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('No time off recorded.')}</p>
              ) : (
                <ul className="divide-y divide-border text-xs" data-testid="time-off">
                  {data.timeOff.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span>
                        <span className="tabular-nums text-foreground">
                          {formatShortDate(entry.startsOn)} – {formatShortDate(entry.endsOn)}
                        </span>
                        <span className="ms-2 text-muted-foreground">
                          {entry.hoursPerDay === null ? t('whole days') : t('{hours} a day', { hours: hours(entry.hoursPerDay) })}
                          {entry.kind ? ` · ${KIND_LABEL[entry.kind]()}` : ''}
                          {entry.source === 'hr' ? ' · HR' : ''}
                        </span>
                        {entry.note ? (
                          <span className="block text-2xs text-muted-foreground" dir="auto">
                            {entry.note}
                          </span>
                        ) : null}
                      </span>
                      {manage ? (
                        <Button variant="ghost" size="icon-sm" aria-label={t('Remove this time off')} onClick={() => setDeleting({ kind: 'time-off', id: entry.id })}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader variant="compact">
              <CardTitle>{t('Available hours, week by week')}</CardTitle>
              <CardDescription>{t('Scheduled hours less time off; nothing on public holidays.')}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <Table data-testid="availability-weeks">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Week of')}</TableHead>
                    <TableHead numeric>{t('Scheduled')}</TableHead>
                    <TableHead numeric>{t('Off')}</TableHead>
                    <TableHead numeric>{t('Available')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.weeks.map((week) => (
                    <TableRow key={week.week}>
                      <TableCell>{formatShortDate(week.week)}</TableCell>
                      <TableCell numeric>{hours(week.scheduled)}</TableCell>
                      <TableCell numeric>{week.off > 0 ? hours(week.off) : '—'}</TableCell>
                      <TableCell numeric className="font-medium">
                        {hours(week.available)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {scheduling ? <ScheduleDialog personId={personId} current={data.schedules.at(-1)?.hours} onClose={() => setScheduling(false)} /> : null}
          {addingOff ? <TimeOffDialog personId={personId} onClose={() => setAddingOff(false)} /> : null}
          <ConfirmDialog
            open={Boolean(deleting)}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={deleting?.kind === 'schedule' ? t('Remove this schedule?') : t('Remove this time off?')}
            description={t('Their available hours are worked out again without it.')}
            confirmLabel={t('Remove')}
            tone="danger"
            pending={removeSchedule.isPending || removeTimeOff.isPending}
            onConfirm={() => {
              if (!deleting) return;
              const done = {
                onSuccess: () => setDeleting(null),
                onError: (error: unknown) => toast.error(t('It was not removed'), { description: error instanceof Error ? error.message : undefined }),
              };
              if (deleting.kind === 'schedule') removeSchedule.mutate(deleting.id, done);
              else removeTimeOff.mutate(deleting.id, done);
            }}
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function ScheduleDialog({ personId, current, onClose }: { personId: string; current?: number[]; onClose: () => void }) {
  const settings = useResourceSettings();
  const standard = settings.data?.settings.hoursPerDay ?? 8;
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [values, setValues] = useState<string[]>((current ?? [standard, standard, standard, standard, standard, 0, 0]).map(String));
  const [fraction, setFraction] = useState('1');
  const save = useSetSchedule(personId);
  const numbers = values.map(Number);
  const fractionValue = Number(fraction);
  const problem =
    !effectiveFrom
      ? t('Give the date it starts from.')
      : numbers.some((value) => !(value >= 0 && value <= 24))
        ? t('Each day is between 0 and 24 hours.')
        : !(fractionValue >= 0 && fractionValue <= 2)
          ? t('The fraction is between 0 and 2: 1 is full time.')
          : null;
  const weekly = numbers.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) * (Number.isFinite(fractionValue) ? fractionValue : 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Set a work schedule')}</DialogTitle>
          <DialogDescription>
            {t('The hours of each weekday at full time, and the fraction employed: half time on a 40-hour week is 0.5. It holds from its date until the next.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-from">{t('From')}</Label>
              <Input id="schedule-from" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-fraction">{t('Employment fraction')}</Label>
              <Input id="schedule-fraction" inputMode="decimal" value={fraction} onChange={(event) => setFraction(event.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((day, index) => (
              <div key={index} className="space-y-1">
                <Label htmlFor={`schedule-day-${index}`} className="block text-center">
                  {day()}
                </Label>
                <Input
                  id={`schedule-day-${index}`}
                  inputMode="decimal"
                  className="px-1 text-center"
                  value={values[index]}
                  onChange={(event) => setValues(values.map((value, at) => (at === index ? event.target.value : value)))}
                />
              </div>
            ))}
          </div>
          <FieldHint>{t('{hours} a week.', { hours: hours(weekly) })}</FieldHint>
          {problem ? <FieldError>{problem}</FieldError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={Boolean(problem)}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { effectiveFrom, hours: numbers, fraction: fractionValue },
                {
                  onSuccess: () => {
                    toast.success(t('Schedule saved'));
                    onClose();
                  },
                  onError: (error) => toast.error(t('The schedule was not saved'), { description: error instanceof Error ? error.message : undefined }),
                },
              )
            }
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimeOffDialog({ personId, onClose }: { personId: string; onClose: () => void }) {
  const [startsOn, setStartsOn] = useState(todayIso());
  const [endsOn, setEndsOn] = useState(todayIso());
  const [whole, setWhole] = useState('whole');
  const [perDay, setPerDay] = useState('4');
  const [kind, setKind] = useState<TimeOffKind>('leave');
  const [note, setNote] = useState('');
  const add = useAddTimeOff(personId);
  const problem =
    !startsOn || !endsOn
      ? t('Give the first and last day.')
      : endsOn < startsOn
        ? t('The last day comes on or after the first.')
        : whole === 'hours' && !(Number(perDay) > 0 && Number(perDay) <= 24)
          ? t('Hours off a day are more than 0 and at most 24.')
          : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Add time off')}</DialogTitle>
          <DialogDescription>{t('The hours off come out of what they have available on each of those days.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="off-from">{t('First day')}</Label>
              <Input id="off-from" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="off-to">{t('Last day')}</Label>
              <Input id="off-to" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="off-whole">{t('How much')}</Label>
              <Select value={whole} onValueChange={setWhole}>
                <SelectTrigger id="off-whole">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whole">{t('Whole days')}</SelectItem>
                  <SelectItem value="hours">{t('Some hours a day')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {whole === 'hours' ? (
              <div className="space-y-1.5">
                <Label htmlFor="off-hours">{t('Hours a day')}</Label>
                <Input id="off-hours" inputMode="decimal" value={perDay} onChange={(event) => setPerDay(event.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="off-kind">{t('Kind')}</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as TimeOffKind)}>
                  <SelectTrigger id="off-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABEL) as TimeOffKind[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {KIND_LABEL[value]()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="off-note">{t('Note')}</Label>
            <Textarea id="off-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} dir="auto" />
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={Boolean(problem)}
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                { startsOn, endsOn, hoursPerDay: whole === 'hours' ? Number(perDay) : null, kind, note: note.trim() || null },
                {
                  onSuccess: () => {
                    toast.success(t('Time off added'));
                    onClose();
                  },
                  onError: (error) => toast.error(t('The time off was not added'), { description: error instanceof Error ? error.message : undefined }),
                },
              )
            }
          >
            {t('Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* The HR source                                                              */
/* -------------------------------------------------------------------------- */

/** A small CSV reader: a header row, commas, and double quotes around a field that holds one. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field.trim());
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field.trim());
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const names = header.map((name) => name.toLowerCase());
  return body.map((cells) => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ''])));
}

const IMPORT_SAMPLE = `record,person,effectiveFrom,fraction,mon,tue,wed,thu,fri,sat,sun,externalId,startsOn,endsOn,hoursPerDay,kind
schedule,someone@example.com,2026-11-01,0.5,8,8,8,8,8,0,0,,,,,
timeoff,someone@example.com,,,,,,,,,,HR-1001,2026-11-16,2026-11-18,,leave`;

const RECONCILE_SAMPLE = `person,from,to,availableHours
someone@example.com,2026-11-01,2026-11-30,72`;

/** One person per row group, from the import CSV. */
function importPeople(rows: Record<string, string>[]): HrImportPerson[] {
  const byPerson = new Map<string, HrImportPerson>();
  const personOf = (value: string) => {
    let entry = byPerson.get(value);
    if (!entry) {
      entry = /^\d+$/.test(value) ? { personId: value } : { email: value };
      byPerson.set(value, entry);
    }
    return entry;
  };
  for (const row of rows) {
    const who = row.person ?? row.email ?? '';
    if (!who) continue;
    const person = personOf(who);
    if ((row.record ?? '').toLowerCase().startsWith('time')) {
      person.timeOff = [
        ...(person.timeOff ?? []),
        {
          externalId: row.externalid ?? '',
          startsOn: row.startson ?? '',
          endsOn: row.endson ?? '',
          hoursPerDay: row.hoursperday ? Number(row.hoursperday) : null,
          kind: (['leave', 'sick', 'training', 'other'].includes(row.kind ?? '') ? row.kind : 'leave') as TimeOffKind,
        },
      ];
    } else {
      const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => row[day]);
      if (row.effectivefrom) person.effectiveFrom = row.effectivefrom;
      if (row.fraction) person.fraction = Number(row.fraction);
      if (days.every((value) => value !== undefined && value !== '')) person.hours = days.map(Number);
    }
  }
  return [...byPerson.values()];
}

function HrTools() {
  const [importText, setImportText] = useState('');
  const [reconcileText, setReconcileText] = useState('');
  const [result, setResult] = useState<HrReconcileResult | null>(null);
  const importHr = useImportHr();
  const reconcile = useReconcileHr();
  const people = useMemo(() => importPeople(parseCsv(importText)), [importText]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader variant="compact">
          <CardTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('Import from the HR source')}
          </CardTitle>
          <CardDescription>
            {t(
              'Schedules and time off, one line each, by email or user id. Time off is matched by the HR source’s own id, so the same extract imported twice changes nothing the second time.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <Textarea rows={6} className="font-mono text-2xs" placeholder={IMPORT_SAMPLE} value={importText} onChange={(event) => setImportText(event.target.value)} />
          <div className="flex items-center justify-between gap-3">
            <FieldHint>{t('{count, plural, one {# person} other {# people}} in this extract.', { count: people.length })}</FieldHint>
            <Button
              size="sm"
              disabled={people.length === 0}
              loading={importHr.isPending}
              onClick={() =>
                importHr.mutate(people, {
                  onSuccess: (outcome) =>
                    toast.success(t('Imported for {count, plural, one {# person} other {# people}}', { count: outcome.people }), {
                      description: [
                        t('{count} schedules', { count: outcome.schedules }),
                        t('{created} time off added, {updated} updated', { created: outcome.timeOffCreated, updated: outcome.timeOffUpdated }),
                        outcome.unknown.length > 0 ? t('not in the directory: {who}', { who: outcome.unknown.join(', ') }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }),
                  onError: (error) => toast.error(t('The import did not go ahead'), { description: error instanceof Error ? error.message : undefined }),
                })
              }
            >
              {t('Import')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('Check against the HR source')}
          </CardTitle>
          <CardDescription>
            {t('The HR source’s available hours for people and periods: each is compared with what EPM works out for the same.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <Textarea rows={4} className="font-mono text-2xs" placeholder={RECONCILE_SAMPLE} value={reconcileText} onChange={(event) => setReconcileText(event.target.value)} />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={!reconcileText.trim()}
              loading={reconcile.isPending}
              onClick={() =>
                reconcile.mutate(
                  parseCsv(reconcileText).map((row) => {
                    const who = row.person ?? row.email ?? '';
                    return {
                      ...(/^\d+$/.test(who) ? { personId: who } : { email: who }),
                      from: row.from ?? '',
                      to: row.to ?? '',
                      availableHours: Number(row.availablehours ?? row.hours ?? ''),
                    };
                  }),
                  {
                    onSuccess: setResult,
                    onError: (error) => toast.error(t('The check did not run'), { description: error instanceof Error ? error.message : undefined }),
                  },
                )
              }
            >
              {t('Check')}
            </Button>
          </div>
          {result ? (
            <div className="space-y-2" data-testid="hr-reconcile">
              <Alert tone={result.differing > 0 || result.unknown > 0 ? 'warning' : 'success'} title={t('{matched} match, {differing} differ, {unknown} unknown', { matched: result.matched, differing: result.differing, unknown: result.unknown })} />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Person')}</TableHead>
                    <TableHead>{t('Period')}</TableHead>
                    <TableHead numeric>HR</TableHead>
                    <TableHead numeric>EPM</TableHead>
                    <TableHead numeric>{t('Difference')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell dir="auto">{row.name ?? row.person}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatShortDate(row.from)} – {formatShortDate(row.to)}
                      </TableCell>
                      <TableCell numeric>{hours(row.hr)}</TableCell>
                      <TableCell numeric>{row.epm === null ? '—' : hours(row.epm)}</TableCell>
                      <TableCell numeric className={row.matches ? 'text-success-strong' : 'text-danger-strong'}>
                        {row.difference === null ? t('unknown') : row.matches ? '✓' : hours(row.difference)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
