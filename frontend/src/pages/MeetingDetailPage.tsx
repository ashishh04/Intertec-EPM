import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Clock, MapPin, Save, Users } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Markdown } from '@/components/common/Markdown';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { MeetingDialog } from '@/components/meetings/MeetingDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  useDeleteMeeting,
  useMeeting,
  useSetAttendance,
  useUpdateMeeting,
} from '@/hooks/useCollaborationModules';
import { useUserMap } from '@/hooks/useUsers';
import { formatLongDate, formatTime, pluralize } from '@/lib/utils';
import type { MeetingState } from '@/types';

const STATE_TONE: Record<MeetingState, 'success' | 'neutral' | 'danger'> = {
  planned: 'success',
  held: 'neutral',
  cancelled: 'danger',
};

/**
 * One meeting: its agenda before, its minutes after, and who was there.
 *
 * The minutes are edited in place rather than in the scheduling dialog, because
 * that is when they are written — during or just after the meeting, with the
 * agenda visible beside them. Putting them behind the same modal as the date and
 * the invite list would mean opening a form about scheduling in order to take
 * notes.
 *
 * Attendance is its own control for the same reason and saves separately, so
 * ticking a box cannot overwrite minutes somebody else is typing.
 */
export default function MeetingDetailPage() {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const query = useMeeting(meetingId);
  const users = useUserMap();

  const update = useUpdateMeeting();
  const setAttendance = useSetAttendance();
  const remove = useDeleteMeeting();

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [attended, setAttended] = useState<Set<string>>(new Set());

  const meeting = query.data;

  // Seeded from the record, and re-seeded if it changes on the server — but not
  // on every render, because the minutes box is being typed into.
  useEffect(() => {
    if (!meeting) return;
    setMinutes(meeting.minutes ?? '');
    setAttended(
      new Set(
        meeting.participants
          .filter((participant) => participant.attended)
          .map((participant) => participant.userId),
      ),
    );
  }, [meeting?.id, meeting?.updatedAt]);

  if (query.isLoading) return <PageSkeleton />;

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => query.refetch()}
      errorTitle="Unable to load this meeting"
      skeleton={<PageSkeleton />}
    >
      {meeting ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow={
              <Link to="/meetings" className="inline-flex items-center gap-1 hover:underline">
                <ArrowLeft className="h-3 w-3" aria-hidden />
                Meetings
              </Link>
            }
            title={meeting.title}
            meta={
              <>
                <Badge tone={STATE_TONE[meeting.state]} size="sm">
                  {meeting.state}
                </Badge>
                {meeting.projectId ? (
                  <Badge tone="neutral" size="sm">
                    <Link to={`/projects/${meeting.projectId}`} className="hover:underline">
                      {meeting.projectName ?? 'Project'}
                    </Link>
                  </Badge>
                ) : (
                  <Badge tone="highlight" size="sm">
                    Organisation-wide
                  </Badge>
                )}
              </>
            }
            description={`${formatLongDate(meeting.startsAt)}, ${formatTime(meeting.startsAt)}–${formatTime(meeting.endsAt)}`}
            actions={
              <>
                {meeting.can.update ? (
                  <Button variant="secondary" onClick={() => setEditing(true)}>
                    Edit details
                  </Button>
                ) : null}
                {meeting.can.delete ? (
                  <Button variant="ghost" onClick={() => setDeleting(true)}>
                    Delete
                  </Button>
                ) : null}
              </>
            }
          />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-4">
              <Card>
                <CardHeader variant="compact">
                  <CardTitle>Agenda</CardTitle>
                  <CardDescription className="text-2xs">
                    What the meeting is for, written before it.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4">
                  <Markdown
                    empty={
                      <p className="text-2xs text-muted-foreground">
                        No agenda was written. Add one from Edit details.
                      </p>
                    }
                  >
                    {meeting.agenda}
                  </Markdown>
                </CardContent>
              </Card>

              <Card>
                <CardHeader variant="compact">
                  <CardTitle>Minutes</CardTitle>
                  <CardDescription className="text-2xs">
                    What was decided, and who is doing what next.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 p-4">
                  {meeting.can.update ? (
                    <>
                      <Label htmlFor="meeting-minutes" className="sr-only">
                        Minutes
                      </Label>
                      <Textarea
                        id="meeting-minutes"
                        rows={12}
                        value={minutes}
                        placeholder={'## Decisions\n- Ship on the 14th\n\n## Actions\n- Priya: update the plan'}
                        onChange={(event) => setMinutes(event.target.value)}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldHint>Markdown. Saved only when you press save.</FieldHint>
                        <Button
                          size="sm"
                          loading={update.isPending}
                          disabled={minutes === (meeting.minutes ?? '')}
                          onClick={() =>
                            update.mutate(
                              {
                                id: meeting.id,
                                input: {
                                  minutes,
                                  // Writing minutes is what makes a meeting held.
                                  // Saved together, so the state cannot lag the
                                  // record that proves it happened — and only from
                                  // `planned`, so a cancelled meeting stays
                                  // cancelled if somebody notes why.
                                  ...(meeting.state === 'planned' ? { state: 'held' as const } : {}),
                                },
                              },
                              {
                                onSuccess: () => toast.success('Minutes saved'),
                                onError: (error) =>
                                  toast.error('The minutes could not be saved', {
                                    description:
                                      error instanceof Error ? error.message : undefined,
                                  }),
                              },
                            )
                          }
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save minutes
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Markdown
                      empty={
                        <p className="text-2xs text-muted-foreground">
                          No minutes have been written yet.
                        </p>
                      }
                    >
                      {meeting.minutes}
                    </Markdown>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader variant="compact">
                  <CardTitle>When and where</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 p-4 text-2xs">
                  <p className="flex items-start gap-2">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      {formatLongDate(meeting.startsAt)}
                      <br />
                      {formatTime(meeting.startsAt)}&ndash;{formatTime(meeting.endsAt)} (
                      {meeting.durationMinutes} min)
                    </span>
                  </p>
                  {meeting.location ? (
                    <p className="flex items-start gap-2">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="break-words">{meeting.location}</span>
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">
                    Scheduled by {meeting.createdByName ?? 'somebody who has since left'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader
                  variant="compact"
                  actions={
                    meeting.can.update ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-2xs"
                        loading={setAttendance.isPending}
                        onClick={() =>
                          setAttendance.mutate(
                            { id: meeting.id, attended: [...attended] },
                            {
                              onSuccess: () => toast.success('Attendance recorded'),
                              onError: (error) =>
                                toast.error('Attendance could not be saved', {
                                  description: error instanceof Error ? error.message : undefined,
                                }),
                            },
                          )
                        }
                      >
                        Save
                      </Button>
                    ) : null
                  }
                >
                  <CardTitle>Participants</CardTitle>
                  <CardDescription className="text-2xs">
                    {meeting.participants.length}{' '}
                    {pluralize(meeting.participants.length, 'person', 'people')} invited
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {meeting.participants.length === 0 ? (
                    <p className="px-4 py-3 text-2xs text-muted-foreground">
                      Nobody is on the list yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {meeting.participants.map((participant) => {
                        const person = users.get(participant.userId);
                        const id = `attended-${participant.userId}`;

                        return (
                          <li key={participant.userId} className="flex items-center gap-2.5 px-4 py-2.5">
                            {meeting.can.update ? (
                              <Checkbox
                                id={id}
                                checked={attended.has(participant.userId)}
                                aria-label={`${participant.name ?? 'This person'} attended`}
                                onCheckedChange={(checked) =>
                                  setAttended((current) => {
                                    const next = new Set(current);
                                    if (checked) next.add(participant.userId);
                                    else next.delete(participant.userId);
                                    return next;
                                  })
                                }
                              />
                            ) : null}
                            <UserAvatar user={person} size="sm" />
                            <label
                              htmlFor={meeting.can.update ? id : undefined}
                              className="min-w-0 flex-1 truncate text-2xs"
                            >
                              {participant.name ?? person?.name ?? 'Unknown'}
                            </label>
                            {!participant.invited ? (
                              <Badge tone="neutral" size="sm">
                                Not invited
                              </Badge>
                            ) : null}
                            {participant.attended ? (
                              <Badge tone="success" size="sm">
                                Came
                              </Badge>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="flex items-center gap-2 p-4 text-2xs text-muted-foreground">
                  <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Attendance is saved separately from the minutes, so ticking a box cannot overwrite
                  notes somebody else is writing.
                </CardContent>
              </Card>
            </div>
          </div>

          <MeetingDialog open={editing} onOpenChange={setEditing} meeting={meeting} />

          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Delete this meeting?"
            description={`"${meeting.title}" and its agenda, minutes and attendance will be removed. This cannot be undone.`}
            confirmLabel="Delete"
            tone="danger"
            pending={remove.isPending}
            onConfirm={() =>
              remove.mutate(meeting.id, {
                onSuccess: () => {
                  toast.success('Meeting deleted');
                  // `replace`, so Back does not return to a meeting that is gone.
                  navigate('/meetings', { replace: true });
                },
                onError: (error) =>
                  toast.error('That meeting could not be deleted', {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              })
            }
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
