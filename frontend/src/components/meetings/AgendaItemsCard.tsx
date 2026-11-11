import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Link2, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';

import { Markdown } from '@/components/common/Markdown';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgendaItems, useAgendaMutations } from '@/hooks/useCollaborationModules';
import { useDebounce } from '@/hooks/useDebounce';
import { useTasks } from '@/hooks/useTasks';
import { t } from '@/lib/i18n';
import type { EpmMeeting, EpmTask, MeetingAgendaItem } from '@/types';

const NONE = '__none__';

/**
 * The agenda, item by item: what is discussed, for how long, by whom, and the
 * task it is about. A task item shows the task as it stands, so the meeting
 * reads its status rather than a copy made when the agenda was written; one the
 * reader may not see stays on the agenda without saying what it is. Notes on
 * each item record what was said and decided.
 */
export function AgendaItemsCard({ meeting }: { meeting: EpmMeeting }) {
  const items = useAgendaItems(meeting.id);
  const mutate = useAgendaMutations(meeting.id);
  const mayEdit = meeting.can.update;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MeetingAgendaItem>();

  const list = items.data ?? [];
  const total = list.reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);

  const move = (index: number, by: -1 | 1) => {
    const ids = list.map((item) => item.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    mutate.order.mutate(ids, {
      onError: (error) => toast.error(t('The agenda could not be reordered'), { description: error instanceof Error ? error.message : undefined }),
    });
  };

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          mayEdit && !adding ? (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('Add item')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{t('Agenda items')}</CardTitle>
        <CardDescription className="text-2xs">
          {list.length > 0 && total > 0
            ? t('{count, plural, one {# item} other {# items}} · {minutes, number} min planned', { count: list.length, minutes: total })
            : t('What is discussed, item by item, with the tasks each one is about.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {items.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : list.length === 0 && !adding ? (
          <p className="text-2xs text-muted-foreground">
            {mayEdit ? t('No items yet. Add one, or link a task to discuss it.') : t('No items on the agenda.')}
          </p>
        ) : (
          <ol className="space-y-2">
            {list.map((item, index) =>
              editing?.id === item.id ? (
                <li key={item.id}>
                  <ItemForm
                    meetingProjectId={meeting.projectId}
                    item={item}
                    pending={mutate.update.isPending}
                    onCancel={() => setEditing(undefined)}
                    onSubmit={(input) =>
                      mutate.update.mutate(
                        { itemId: item.id, input },
                        {
                          onSuccess: () => {
                            setEditing(undefined);
                            toast.success(t('Agenda item saved'));
                          },
                          onError: (error) =>
                            toast.error(t('The agenda item could not be saved'), {
                              description: error instanceof Error ? error.message : undefined,
                            }),
                        },
                      )
                    }
                  />
                </li>
              ) : (
                <li key={item.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium" dir="auto">
                          {item.title}
                        </span>
                        {item.durationMinutes ? (
                          <Badge tone="neutral" size="sm">
                            {t('{minutes, number} min', { minutes: item.durationMinutes })}
                          </Badge>
                        ) : null}
                        {item.presenterName ? (
                          <span className="text-2xs text-muted-foreground">{t('Presented by {name}', { name: item.presenterName })}</span>
                        ) : null}
                      </div>
                      {item.task ? (
                        item.task.visible ? (
                          <Link
                            to={`/tasks/${item.task.id}`}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-2xs hover:border-primary/40"
                          >
                            <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="shrink-0 font-mono text-muted-foreground">{item.task.key}</span>
                            <span className="truncate" dir="auto">
                              {item.task.subject}
                            </span>
                            {item.task.statusCategory ? (
                              <StatusBadge status={item.task.statusCategory} label={item.task.status} size="sm" />
                            ) : null}
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
                            <Link2 className="h-3 w-3" aria-hidden />
                            {t('A task you cannot see')}
                          </span>
                        )
                      ) : null}
                      {item.notes ? (
                        <div className="rounded-md bg-muted/40 px-2.5 py-2 text-xs" dir="auto">
                          <Markdown>{item.notes}</Markdown>
                        </div>
                      ) : null}
                    </div>
                    {mayEdit ? (
                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Move up')}
                          disabled={index === 0 || mutate.order.isPending}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Move down')}
                          disabled={index === list.length - 1 || mutate.order.isPending}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={t('Edit {name}', { name: item.title })} onClick={() => setEditing(item)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Remove {name}', { name: item.title })}
                          className="hover:bg-danger-soft hover:text-danger"
                          onClick={() =>
                            mutate.remove.mutate(item.id, {
                              onSuccess: () => toast.success(t('Agenda item removed')),
                              onError: (error) =>
                                toast.error(t('The agenda item could not be removed'), {
                                  description: error instanceof Error ? error.message : undefined,
                                }),
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              ),
            )}
          </ol>
        )}

        {adding ? (
          <ItemForm
            meetingProjectId={meeting.projectId}
            pending={mutate.add.isPending}
            onCancel={() => setAdding(false)}
            onSubmit={(input) =>
              mutate.add.mutate(input, {
                onSuccess: () => {
                  setAdding(false);
                  toast.success(t('Added to the agenda'));
                },
                onError: (error) =>
                  toast.error(t('That could not be added to the agenda'), {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              })
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Adding or changing one item: a title, or a task it takes its title from. */
function ItemForm({
  item,
  meetingProjectId,
  pending,
  onCancel,
  onSubmit,
}: {
  item?: MeetingAgendaItem;
  meetingProjectId?: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: { title?: string; durationMinutes: number | null; workPackageId: string | null; notes: string | null }) => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [duration, setDuration] = useState(item?.durationMinutes ? String(item.durationMinutes) : NONE);
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [task, setTask] = useState<{ id: string; label: string } | undefined>(
    item?.task ? { id: item.task.id, label: item.task.visible ? `${item.task.key} · ${item.task.subject}` : t('A task you cannot see') } : undefined,
  );
  const [term, setTerm] = useState('');
  const search = useDebounce(term.trim(), 250);
  // The meeting's own project first: that is where its tasks usually are.
  const found = useTasks(
    { search, pageSize: 8, ...(meetingProjectId ? { projectId: meetingProjectId } : {}) },
    { enabled: search.length >= 2 },
  );
  const [problem, setProblem] = useState<string>();

  const choose = (picked: EpmTask) => {
    setTask({ id: picked.id, label: `${picked.key} · ${picked.subject}` });
    if (!title.trim()) setTitle(picked.subject);
    setTerm('');
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() && !task) return setProblem(t('Give the item a title, or choose a task.'));
        onSubmit({
          title: title.trim() || undefined,
          durationMinutes: duration === NONE ? null : Number(duration),
          workPackageId: task?.id ?? null,
          notes: notes.trim() || null,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="space-y-1.5">
          <Label htmlFor="agenda-title">{t('Title')}</Label>
          <Input id="agenda-title" value={title} maxLength={300} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agenda-duration">{t('Time')}</Label>
          <Select value={duration} onValueChange={setDuration}>
            <SelectTrigger id="agenda-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('Not set')}</SelectItem>
              {[5, 10, 15, 20, 30, 45, 60].map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {t('{minutes, number} min', { minutes })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agenda-task">{t('Task')}</Label>
        {task ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate" dir="auto">
              {task.label}
            </span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Remove the task')} onClick={() => setTask(undefined)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <Input
              id="agenda-task"
              value={term}
              placeholder={t('Search tasks by title or number')}
              onChange={(event) => setTerm(event.target.value)}
            />
            {search.length >= 2 ? (
              <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
                {(found.data?.items ?? []).map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => choose(candidate)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-start text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    >
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">{candidate.key}</span>
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {candidate.subject}
                      </span>
                      <StatusBadge status={candidate.statusCategory} label={candidate.status.name} size="sm" />
                    </button>
                  </li>
                ))}
                {found.isSuccess && (found.data?.items.length ?? 0) === 0 ? (
                  <li className="px-2.5 py-2 text-2xs text-muted-foreground">{t('Nothing matched that search.')}</li>
                ) : null}
              </ul>
            ) : (
              <FieldHint>{t('Optional. The item then shows the task and its status as they stand.')}</FieldHint>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agenda-notes">{t('Notes')}</Label>
        <Textarea
          id="agenda-notes"
          rows={2}
          value={notes}
          placeholder={t('What was said and decided.')}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {problem ? <Alert tone="danger">{problem}</Alert> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          {t('Cancel')}
        </Button>
        <Button type="submit" size="sm" loading={pending}>
          {item ? t('Save') : t('Add to agenda')}
        </Button>
      </div>
    </form>
  );
}
