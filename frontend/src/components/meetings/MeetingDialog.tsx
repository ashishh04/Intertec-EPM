import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { MultiSelect, type MultiSelectOption } from '@/components/common/MultiSelect';
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
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateMeeting, useUpdateMeeting } from '@/hooks/useCollaborationModules';
import { useProjects } from '@/hooks/useProjects';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmMeeting, ID, MeetingState } from '@/types';

/**
 * Schedules or edits a meeting.
 *
 * The date and time are two fields, not one `datetime-local`. That control is
 * genuinely awkward — inconsistent between browsers, hostile on a phone, and it
 * hides which half a person is editing — and a meeting is planned as a day and a
 * time anyway. They are combined into an instant on submit, in the browser's own
 * zone, which is where somebody reading "10:00" means ten o'clock.
 *
 * Duration rather than an end time, for the same reason the record stores one: a
 * meeting is booked as "an hour", and two editable values that must agree is a
 * pair that eventually will not.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const STATES: { value: MeetingState; label: string }[] = [
  { value: 'planned', get label() { return t('Planned'); } },
  { value: 'held', get label() { return t('Held'); } },
  { value: 'cancelled', get label() { return t('Cancelled'); } },
];

interface MeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing meeting rather than scheduling a new one. */
  meeting?: EpmMeeting;
  /** Pre-selected project, from a project's own Meetings tab. */
  projectId?: ID;
}

/** `YYYY-MM-DD` and `HH:MM` for an instant, in the browser's own zone. */
function splitInstant(iso?: string): { date: string; time: string } {
  const at = iso ? new Date(iso) : new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

export function MeetingDialog({ open, onOpenChange, meeting, projectId }: MeetingDialogProps) {
  const { user } = useAuth();
  const create = useCreateMeeting();
  const update = useUpdateMeeting();
  const pending = create.isPending || update.isPending;

  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<string | undefined>();
  const [location, setLocation] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(60);
  const [state, setState] = useState<MeetingState>('planned');
  const [agenda, setAgenda] = useState('');
  const [participants, setParticipants] = useState<MultiSelectOption[]>([]);
  const [problem, setProblem] = useState<string>();

  const projectsQuery = useProjects();
  const usersQuery = useUsers();

  const peopleOptions = useMemo(
    () => (usersQuery.data ?? []).map((person) => ({ id: person.id, name: person.name })),
    [usersQuery.data],
  );

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  useEffect(() => {
    if (!open) return;

    const { date: startDate, time: startTime } = splitInstant(meeting?.startsAt);
    setTitle(meeting?.title ?? '');
    setScope(meeting?.projectId ?? projectId);
    setLocation(meeting?.location ?? '');
    setDate(startDate);
    // A new meeting defaults to the next round hour rather than now: nobody
    // schedules something for 14:37.
    setTime(meeting ? startTime : `${String((new Date().getHours() + 1) % 24).padStart(2, '0')}:00`);
    setDuration(meeting?.durationMinutes ?? 60);
    setState(meeting?.state ?? 'planned');
    setAgenda(meeting?.agenda ?? '');
    setParticipants(
      meeting
        ? meeting.participants.map((participant) => ({
            id: participant.userId,
            name: participant.name ?? participant.userId,
          }))
        : user
          ? [{ id: user.id, name: user.name }]
          : [],
    );
    setProblem(undefined);
  }, [open, meeting, projectId, user]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (!title.trim()) return setProblem(t('Give the meeting a title.'));
    if (!date || !time) return setProblem(t('Choose a date and a start time.'));

    const startsAt = new Date(`${date}T${time}`);
    if (Number.isNaN(startsAt.getTime())) return setProblem(t('That date and time could not be read.'));

    const input = {
      title: title.trim(),
      projectId: scope,
      location: location.trim() || undefined,
      // Sent as a full instant with an offset, so the server stores the moment
      // rather than a wall-clock time whose zone it has to guess.
      startsAt: startsAt.toISOString(),
      durationMinutes: duration,
      agenda: agenda.trim() || undefined,
      state,
      participantIds: participants.map((option) => option.id),
    };

    const failed = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : t('That could not be saved.'));

    if (meeting) {
      update.mutate(
        { id: meeting.id, input },
        {
          onSuccess: () => {
            toast.success(t('Meeting updated'));
            onOpenChange(false);
          },
          onError: failed,
        },
      );
      return;
    }

    create.mutate(input, {
      onSuccess: () => {
        toast.success(t('Meeting scheduled'));
        onOpenChange(false);
      },
      onError: failed,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{meeting ? t('Edit meeting') : t('Schedule a meeting')}</DialogTitle>
            <DialogDescription>
              {meeting
                ? t('Changes are visible to everybody who can see the meeting.')
                : t('Everyone you invite can see it, and anyone in the project can find it.')}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body space-y-4 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="meeting-title" required>
                {t('Title')}
              </Label>
              <Input
                id="meeting-title"
                value={title}
                autoFocus
                placeholder={t('Sprint review')}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meeting-project">{t('Project')}</Label>
              <ComboSelect
                id="meeting-project"
                label={t('Project')}
                options={projectOptions}
                value={scope}
                clearable
                loading={projectsQuery.isLoading}
                placeholder={t('Organisation-wide')}
                emptyLabel={t('No projects match')}
                onChange={setScope}
              />
              <FieldHint>
                {t('Leave it empty for a meeting that belongs to the organisation rather than to one project. Only an administrator can create those.')}
              </FieldHint>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-date" required>
                  {t('Date')}
                </Label>
                <Input
                  id="meeting-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-time" required>
                  {t('Starts')}
                </Label>
                <Input
                  id="meeting-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-duration">{t('For')}</Label>
                <Select value={String(duration)} onValueChange={(value) => setDuration(Number(value))}>
                  <SelectTrigger id="meeting-duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {minutes < 60
                          ? t('{minutes, number} min', { minutes })
                          : t('{hours, plural, one {# hour} other {# hours}}', { hours: minutes / 60 })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-location">{t('Where')}</Label>
                <Input
                  id="meeting-location"
                  value={location}
                  placeholder={t('Meeting room 2, or a call link')}
                  onChange={(event) => setLocation(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-state">{t('Status')}</Label>
                <Select value={state} onValueChange={(value) => setState(value as MeetingState)}>
                  <SelectTrigger id="meeting-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('Invite')}</Label>
              <MultiSelect
                label={t('Participants')}
                options={peopleOptions}
                selected={participants}
                onChange={setParticipants}
                placeholder={t('Choose people')}
                disabled={usersQuery.isLoading}
                maxVisible={3}
              />
              <FieldHint>{t('Attendance is recorded afterwards, on the meeting itself.')}</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meeting-agenda">{t('Agenda')}</Label>
              <Textarea
                id="meeting-agenda"
                rows={6}
                value={agenda}
                placeholder={t('## Decisions needed\n- Release date\n- Scope of the next sprint')}
                onChange={(event) => setAgenda(event.target.value)}
              />
              <FieldHint>{t('Markdown. Headings, lists and links all work.')}</FieldHint>
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {meeting ? t('Save changes') : t('Schedule')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
