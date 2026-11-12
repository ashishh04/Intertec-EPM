import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, OctagonAlert, Plus } from 'lucide-react';

import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useImpediments, useRaiseImpediment } from '@/hooks/useBoards';
import { useUpdateTask } from '@/hooks/useTasks';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmTask, ID, Impediment } from '@/types';

const NOBODY = '__nobody__';

/**
 * What is in the way of a sprint, for one project: each impediment with the
 * tasks it holds up, open ones first. Raising one blocks the tasks chosen;
 * resolving it closes it, and the tasks it held up are free again.
 */
export function ImpedimentsPanel({ sprintId, projectId, tasks }: { sprintId: ID; projectId: ID; tasks: EpmTask[] }) {
  const impediments = useImpediments(sprintId, projectId);
  const updateTask = useUpdateTask();
  const users = useUserMap();
  const { canInProject } = useAuth();
  const [raising, setRaising] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const all = impediments.data ?? [];
  const open = all.filter((one) => !one.status.isClosed);
  const resolved = all.filter((one) => one.status.isClosed);
  const impedimentIds = new Set(all.map((one) => one.id));
  const candidates = tasks.filter((task) => !impedimentIds.has(task.id) && !task.status.isClosed);

  const resolve = (impediment: Impediment) =>
    updateTask.mutate(
      { id: impediment.id, status: 'done' },
      {
        onSuccess: () => toast.success(t('Impediment resolved'), { description: impediment.key }),
        onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }),
      },
    );

  return (
    <Card>
      <CardHeader variant="compact" className="border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <OctagonAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('Impediments')}
            {open.length > 0 ? <span className="rounded-full bg-danger-soft px-1.5 font-mono text-2xs text-danger-strong">{open.length}</span> : null}
          </CardTitle>
          {canInProject(projectId, 'task:create') ? (
            <Button size="sm" variant="ghost" onClick={() => setRaising(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('Raise')}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {impediments.isLoading ? (
          <Skeleton className="h-12 rounded-md" />
        ) : open.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('Nothing is in the way of this sprint.')}</p>
        ) : (
          <ul className="space-y-2">
            {open.map((impediment) => (
              <li key={impediment.id} className="rounded-md border border-danger/30 bg-danger-soft/30 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/tasks/${impediment.id}`} className="font-mono text-2xs text-muted-foreground hover:text-primary hover:underline">
                      {impediment.key}
                    </Link>
                    <p className="text-xs font-medium" dir="auto">
                      {impediment.subject}
                    </p>
                  </div>
                  <UserAvatarWithTooltip user={impediment.assigneeId ? users.get(impediment.assigneeId) : undefined} size="xs" />
                </div>
                {impediment.blocks.length > 0 ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
                    {t('Holds up')}
                    {impediment.blocks.map((task) => (
                      <Link key={task.id} to={`/tasks/${task.id}`} title={task.subject} className="rounded bg-surface px-1 font-mono hover:text-primary hover:underline">
                        {task.key}
                      </Link>
                    ))}
                  </p>
                ) : null}
                {canInProject(projectId, 'task:edit') ? (
                  <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-2xs" loading={updateTask.isPending} onClick={() => resolve(impediment)}>
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('Resolve')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {resolved.length > 0 ? (
          <div>
            <button type="button" className="text-2xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowResolved((value) => !value)}>
              {showResolved ? t('Hide the resolved ones') : t('{count, plural, one {# resolved} other {# resolved}}', { count: resolved.length })}
            </button>
            {showResolved ? (
              <ul className="mt-1.5 space-y-1">
                {resolved.map((impediment) => (
                  <li key={impediment.id} className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
                    <Link to={`/tasks/${impediment.id}`} className="font-mono hover:underline">
                      {impediment.key}
                    </Link>
                    <span className="truncate line-through" dir="auto">
                      {impediment.subject}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <RaiseImpedimentDialog open={raising} onOpenChange={setRaising} sprintId={sprintId} projectId={projectId} candidates={candidates} />
    </Card>
  );
}

function RaiseImpedimentDialog({
  open,
  onOpenChange,
  sprintId,
  projectId,
  candidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sprintId: ID;
  projectId: ID;
  candidates: EpmTask[];
}) {
  const raise = useRaiseImpediment(sprintId);
  const users = useUsers();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(NOBODY);
  const [blocks, setBlocks] = useState<Set<ID>>(new Set());
  const [problem, setProblem] = useState<string>();
  const people = useMemo(() => (users.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [users.data]);

  useEffect(() => {
    if (!open) return;
    setSubject('');
    setDescription('');
    setAssigneeId(NOBODY);
    setBlocks(new Set());
    setProblem(undefined);
  }, [open]);

  const toggle = (id: ID, on: boolean) =>
    setBlocks((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () => {
    if (!subject.trim()) return setProblem(t('A title is required.'));
    if (blocks.size === 0) return setProblem(t('Choose at least one task it holds up.'));
    setProblem(undefined);
    raise.mutate(
      {
        projectId,
        subject: subject.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(assigneeId !== NOBODY ? { assigneeId } : {}),
        blocksIds: [...blocks],
      },
      {
        onSuccess: (made) => {
          toast.success(t('Impediment raised'), { description: made.key });
          onOpenChange(false);
        },
        onError: (error) => setProblem(error instanceof Error ? error.message : t('That could not be changed')),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Raise an impediment')}</DialogTitle>
          <DialogDescription>{t('Something in the way of the sprint. The tasks it holds up are marked as blocked by it until it is resolved.')}</DialogDescription>
        </DialogHeader>
        <div className="epm-dialog-body epm-scroll space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="impediment-subject" required>
              {t('What is in the way')}
            </Label>
            <Input id="impediment-subject" value={subject} maxLength={255} autoFocus onChange={(event) => setSubject(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="impediment-description">{t('Details')}</Label>
            <Textarea id="impediment-description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="impediment-assignee">{t('Who is clearing it')}</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger id="impediment-assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NOBODY}>{t('Nobody yet')}</SelectItem>
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">{t('Tasks it holds up')}</legend>
            {candidates.length === 0 ? (
              <p className="text-2xs text-muted-foreground">{t('This project has no open work in the sprint.')}</p>
            ) : (
              <ul className="epm-scroll max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1.5">
                {candidates.map((task) => (
                  <li key={task.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
                      <Checkbox checked={blocks.has(task.id)} onCheckedChange={(checked) => toggle(task.id, checked === true)} />
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">{task.key}</span>
                      <span className="min-w-0 truncate" dir="auto">
                        {task.subject}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button loading={raise.isPending} onClick={submit}>
            {t('Raise the impediment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
