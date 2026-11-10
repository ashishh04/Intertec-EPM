import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { env } from '@/config/env';
import { useAddProjectMember, useProjectRoles } from '@/hooks/useMembers';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { intlLocale, t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { apiClient } from '@/services/api/client';
import type { TaskImportPerson, TaskImportTimeRefusal, TaskImportView } from '@/types';

/** Why spent time will not be logged, as the check says it. */
function refusalText(reason: TaskImportTimeRefusal): string {
  switch (reason) {
    case 'locked':
      return t('the timesheet for that day has been submitted or approved');
    case 'backdating':
      return t('it is older than the back-dating window allows');
    case 'activity':
      return t('an activity is required, and the file has none');
    case 'closed':
      return t('the task is closed, and closed work takes no time');
    case 'daily':
      return t('it would pass the daily maximum of hours');
  }
}

/**
 * Imports a CSV or Excel file into a project. One rule: a row whose ID is a
 * task of this project — WP and its number, as Export writes it, or an ID an
 * earlier import made the task from — updates that task, only the cells that
 * differ; every other row is created. Nothing is deleted. So the same sheet,
 * edited and uploaded again and again, overwrites; it never duplicates. The file is checked first and what it will do is shown — so many
 * new, so many changed, and each change — before anything happens. Large files
 * run in the background with progress, and can be resumed if they stop.
 */
export function ImportTasksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useProjects();
  const { canInProject } = useAuth();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState<string>();
  const [file, setFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<TaskImportView | null>(null);
  // Checked to leave out the people the project cannot give work to.
  const [withoutPeople, setWithoutPeople] = useState(false);
  // The role people the file names are added to the project with.
  const [roleId, setRoleId] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const canAddPeople = projectId ? canInProject(projectId, 'member:manage') : false;
  const roles = useProjectRoles(open && canAddPeople && Boolean(view?.people.some((person) => person.state === 'account')));
  const addMember = useAddProjectMember(projectId ?? '');

  useEffect(() => {
    if (!open) {
      setFile(null);
      setView(null);
      setWithoutPeople(false);
    }
  }, [open]);

  // While it runs, its progress every two seconds.
  useEffect(() => {
    if (view?.status !== 'running') return;
    const timer = setInterval(async () => {
      const next = await apiClient.get<TaskImportView>(`/task-imports/${view.id}`).catch(() => null);
      if (!next) return;
      setView(next);
      if (next.status !== 'running') {
        void client.invalidateQueries();
        if (next.status === 'done') toast.success(t('{created} created, {updated} updated', { created: formatNumber(next.created), updated: formatNumber(next.updated) }));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [view?.id, view?.status, client]);

  // Only projects the file can go into: a public project is visible to anyone signed
  // in, and was offered here only for the check to be refused.
  const options = useMemo(
    () =>
      (projects.data ?? [])
        .filter((project) => canInProject(project.id, 'task:create'))
        .map((project) => ({ id: project.id, name: project.name, hint: project.identifier })),
    [projects.data, canInProject],
  );

  const downloadTemplate = async () => {
    if (!projectId) return;
    try {
      saveBlob(await apiClient.download(`/projects/${projectId}/task-imports/template`), 'epm-task-import-template.xlsx');
    } catch (error) {
      toast.error(t('The download failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };

  // After an import, the project as it now is, with every task's ID, to keep working from.
  const downloadSheet = async () => {
    if (!projectId) return;
    try {
      const identifier = (projects.data ?? []).find((project) => project.id === projectId)?.identifier ?? `project-${projectId}`;
      saveBlob(await apiClient.download(`/projects/${projectId}/task-exports`, { format: 'xlsx' }, 300_000), `${identifier}-tasks-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error) {
      toast.error(t('The download failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };

  const check = async (leaveOut = withoutPeople) => {
    if (!projectId || !file) return;
    setChecking(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const response = await fetch(`${env.apiBaseUrl}/projects/${projectId}/task-imports${leaveOut ? '?withoutPeople=true' : ''}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept-Language': intlLocale() },
        body,
      });
      const json = (await response.json()) as TaskImportView & { message?: string };
      if (!response.ok) throw new Error(json.message ?? response.statusText);
      setView(json);
    } catch (error) {
      toast.error(t('The file could not be checked'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    if (!view) return;
    try {
      setView(await apiClient.post<TaskImportView>(`/task-imports/${view.id}/run`));
    } catch (error) {
      toast.error(t('The import did not start'), { description: error instanceof Error ? error.message : undefined });
    }
  };

  const cancel = async () => {
    if (view) setView(await apiClient.post<TaskImportView>(`/task-imports/${view.id}/cancel`));
  };

  // Adds someone the file names to the project, then checks the file again.
  const addPerson = async (person: TaskImportPerson) => {
    if (!person.userId || !roleId) return;
    setAdding(person.userId);
    try {
      await addMember.mutateAsync({ userId: person.userId, roleIds: [roleId] });
      toast.success(t('{name} was added to the project', { name: person.name }));
      await check();
    } catch (error) {
      toast.error(t('That could not be saved.'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setAdding(null);
    }
  };

  const importWithoutPeople = () => {
    setWithoutPeople(true);
    void check(true);
  };

  const work = view ? view.toCreate + view.toUpdate : 0;
  const done = view ? view.created + view.updated + view.failed : 0;
  const percent = work > 0 ? Math.min(100, Math.round((done / work) * 100)) : 0;
  const started = view && ['running', 'done', 'cancelled', 'failed'].includes(view.status);
  const clean = view && view.problemCount === 0;
  // People are shown on their own, with what can be done about each; the rest as problems.
  const people = view?.people ?? [];
  const otherProblems = view ? view.problems.filter((problem) => !problem.person) : [];
  const otherProblemCount = view ? view.problemCount - people.length : 0;
  const time = view?.time;

  const runLabel = (view: TaskImportView) => {
    if (view.status !== 'checked') return t('Resume the import');
    if (view.toCreate > 0 && view.toUpdate > 0) return t('Create {created} and update {updated}', { created: formatNumber(view.toCreate), updated: formatNumber(view.toUpdate) });
    if (view.toUpdate > 0) return t('Update {count} tasks', { count: formatNumber(view.toUpdate) });
    return t('Create {count} tasks', { count: formatNumber(view.toCreate) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Import tasks')}</DialogTitle>
          <DialogDescription>{t('Create new tasks, or change existing ones, from a CSV or Excel file. Nothing changes until you have seen what the file will do.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
            <div className="mb-1.5 font-medium">{t('How each row is read')}</div>
            <ul className="list-disc space-y-1 ps-4">
              <li>{t('An ID such as WP1234 that is a task of this project: that task is updated — only the cells that differ.')}</li>
              <li>{t('Any other row is created as a new task. Give new rows your own IDs (E1, T1…) to set their Parent ID and Predecessors.')}</li>
              <li>{t('Upload the same sheet again after editing it: rows whose IDs were imported before update their tasks, so nothing is created twice. Progress (Done %), dates, status and the rest are overwritten.')}</li>
              <li>{t('Tasks not in the file are left as they are: the import never deletes.')}</li>
              <li>{t('A work package export in its own layout (CSV or XLS, with columns such as id, Parent and % Complete) is read too: its IDs are the same tasks, so it updates them in the same way.')}</li>
            </ul>
            <div className="mt-2 text-muted-foreground">
              {t('To change many tasks at once: Export, edit the file, import it into the same project. To copy a project’s tasks: import the export into another project. To start a plan: use the template.')}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-project" required>
              {t('Project')}
            </Label>
            <ComboSelect id="import-project" label={t('Project')} options={options} value={projectId} onChange={(value) => { setProjectId(value); setView(null); setWithoutPeople(false); }} disabled={view?.status === 'running'} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="import-file">{t('File (CSV or Excel)')}</Label>
              <Input
                id="import-file"
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="w-80"
                disabled={view?.status === 'running'}
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setView(null); setWithoutPeople(false); }}
              />
            </div>
            <Button variant="outline" disabled={!projectId} onClick={() => void downloadTemplate()}>
              <Download className="h-4 w-4" />
              {t('Blank template')}
            </Button>
          </div>

          {view ? (
            <div className="space-y-3 rounded-md border border-border p-3 text-xs">
              <div className="font-medium" dir="auto">
                {view.fileName}: {t('{count} rows', { count: formatNumber(view.total) })}
              </div>
              {clean ? (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded border border-border p-2">
                    <div className="text-lg font-semibold">{formatNumber(view.toCreate)}</div>
                    <div className="text-muted-foreground">{t('new tasks')}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-lg font-semibold">{formatNumber(view.toUpdate)}</div>
                    <div className="text-muted-foreground">{t('tasks changed')}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-lg font-semibold">{formatNumber(view.unchanged)}</div>
                    <div className="text-muted-foreground">{t('unchanged')}</div>
                  </div>
                </div>
              ) : null}
              {clean && (view.relations > 0 || view.relationsRemoved > 0 || view.toCreate > 0) ? (
                <div className="text-muted-foreground">
                  {view.toCreate > 0
                    ? `${Object.entries(view.byType)
                        .map(([type, count]) => `${type} ${formatNumber(count)}`)
                        .join(' · ')} · ${t('{levels} levels', { levels: view.levels })} · `
                    : ''}
                  {t('{added} dependencies to add, {removed} to remove', { added: formatNumber(view.relations), removed: formatNumber(view.relationsRemoved) })}
                </div>
              ) : null}
              {clean && view.copies > 0 ? (
                <Alert tone="warning" title={t('{count} rows are tasks of another project', { count: formatNumber(view.copies) })}>
                  {t('Their IDs are not tasks of this project, so they will be created here as new copies. If you meant to update the originals, choose their project instead.')}
                </Alert>
              ) : null}
              {view.source?.format === 'openproject' && !started ? (
                <div className="text-muted-foreground">
                  {view.source.dateOrder === 'day-first'
                    ? t('Read as a work package export, its dates day first (02/11 is 2 November).')
                    : view.source.dateOrder === 'month-first'
                      ? t('Read as a work package export, its dates month first (11/02 is 2 November).')
                      : t('Read as a work package export.')}
                </div>
              ) : null}
              {view.source && view.source.ignoredColumns.length > 0 && !started ? (
                <div className="text-muted-foreground" dir="auto">
                  {t('Not imported (for reading only, or worked out by EPM): {columns}', { columns: view.source.ignoredColumns.join(', ') })}
                </div>
              ) : null}
              {clean && view.datesMoved > 0 && !started ? (
                <div className="text-muted-foreground">{t('{count} dates fall on a weekend or holiday and are moved to the next working day, as the schedule does.', { count: formatNumber(view.datesMoved) })}</div>
              ) : null}
              {clean && view.peopleLeftOut.length > 0 && !started ? (
                <div className="text-muted-foreground" dir="auto">
                  {t('Imported without: {people}. Their cells are left blank on new tasks; tasks being updated keep who they have now.', {
                    people: view.peopleLeftOut.map((one) => t('{name} ({count, plural, one {# row} other {# rows}})', { name: one.name, count: one.rows })).join(', '),
                  })}
                </div>
              ) : null}
              {clean && time && !started && (time.entries > 0 || time.withoutPerson.entries > 0 || time.refused.length > 0) ? (
                <div className="space-y-0.5 text-muted-foreground">
                  {time.entries > 0 ? (
                    <div>
                      {t('Spent time: {hours} h will be logged as {count, plural, one {# entry} other {# entries}}, one for each new task, for its assignee on its finish date.', { hours: formatNumber(time.hours), count: time.entries })}
                    </div>
                  ) : null}
                  {time.withoutPerson.entries > 0 ? (
                    <div>{t('{hours} h on {count, plural, one {# new task} other {# new tasks}} with no assignee will not be logged.', { hours: formatNumber(time.withoutPerson.hours), count: time.withoutPerson.entries })}</div>
                  ) : null}
                  {time.refused.map((entry) => (
                    <div key={entry.reason}>
                      {t('{hours} h on {count, plural, one {# new task} other {# new tasks}} will not be logged: {reason}.', { hours: formatNumber(entry.hours), count: entry.entries, reason: refusalText(entry.reason) })}
                    </div>
                  ))}
                </div>
              ) : null}
              {clean && view.repeatCount > 0 && !started ? (
                <Alert tone="warning" title={t('{count, plural, one {# new row repeats an earlier row} other {# new rows repeat an earlier row}}', { count: view.repeatCount })}>
                  <div>{t('The same name under the same parent: each is created as a task of its own. If they are the same task, take the extra rows out of the file.')}</div>
                  <div className="mt-1 max-h-24 overflow-y-auto" dir="auto">
                    {view.repeats.map((entry) => (
                      <div key={entry.row}>
                        {t('Line {row}', { row: entry.row })}: {entry.subject} — {t('as line {row}', { row: entry.firstRow })}
                      </div>
                    ))}
                  </div>
                </Alert>
              ) : null}
              {clean && view.matchedEarlier > 0 && !started ? (
                <div className="text-muted-foreground">{t('{count} rows were matched by IDs from an earlier import into this project, and update those tasks.', { count: formatNumber(view.matchedEarlier) })}</div>
              ) : null}
              {clean && view.sameSubject.length > 0 && !started ? (
                <Alert tone="warning" title={t('{count} new rows have the name of a task already in this project', { count: formatNumber(view.sameSubject.length) })}>
                  <div>{t('They will be created as new tasks. If they are meant to update those tasks, put the task’s ID (as in the export) in the ID column.')}</div>
                  <div className="mt-1 max-h-24 overflow-y-auto" dir="auto">
                    {view.sameSubject.map((entry) => (
                      <div key={entry.row}>
                        {t('Line {row}', { row: entry.row })}: {entry.subject} → <span className="font-mono">{entry.existing}</span>
                      </div>
                    ))}
                  </div>
                </Alert>
              ) : null}
              {clean && view.progressIgnored > 0 && !started ? (
                <Alert tone="warning" title={t('Done % is ignored for {count} rows', { count: formatNumber(view.progressIgnored) })}>
                  {t('Progress here follows each task’s status, so it cannot be set from a file. Change the status instead.')}
                </Alert>
              ) : null}
              {clean && view.datesSkipped.length > 0 && !started ? (
                <Alert tone="warning" title={t('{count} date changes will be skipped', { count: formatNumber(view.datesSkipped.length) })}>
                  <div>{t('These dates are set by the schedule: a task with subtasks takes its dates from them, and a task that follows another starts when that one ends. Change those tasks instead, or download the updated sheet after importing to see the dates as scheduled.')}</div>
                  <div className="mt-1 max-h-24 overflow-y-auto" dir="auto">
                    {view.datesSkipped.map((entry) => (
                      <div key={entry.row}>
                        <span className="font-mono">{entry.key}</span> {entry.subject} — {entry.reason === 'children' ? t('dates follow its subtasks') : t('starts after the task it follows')}
                      </div>
                    ))}
                  </div>
                </Alert>
              ) : null}
              {clean && view.changes.length > 0 && !started ? (
                <div className="space-y-1.5">
                  <div className="font-medium">{t('What changes')}</div>
                  <div className="max-h-56 overflow-y-auto rounded border border-border">
                    <table className="w-full">
                      <tbody>
                        {view.changes.map((entry) => (
                          <tr key={entry.row} className="border-b border-border last:border-0">
                            <td className="whitespace-nowrap p-1.5 pe-3 align-top font-mono">{entry.key}</td>
                            <td className="p-1.5 pe-3 align-top" dir="auto">
                              {entry.subject}
                            </td>
                            <td className="p-1.5 align-top">
                              {entry.changes.map((change) => (
                                <div key={change.column} dir="auto">
                                  <span className="font-medium">{t(change.column)}</span>: <span className="text-muted-foreground line-through">{change.from || t('(empty)')}</span> → {change.to || t('(empty)')}
                                </div>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {view.toUpdate > view.changes.length ? <div className="text-muted-foreground">{t('The first {shown} of {count} are shown.', { shown: formatNumber(view.changes.length), count: formatNumber(view.toUpdate) })}</div> : null}
                </div>
              ) : null}
              {clean && work === 0 ? <Alert tone="neutral" title={t('Nothing to do: every row matches its task already.')} /> : null}
              {people.length > 0 && !started ? (
                <Alert tone="warning" title={t('{count, plural, one {# person in the file cannot be given its tasks here} other {# people in the file cannot be given its tasks here}}', { count: people.length })}>
                  <div>{t('Add them to the project and the file is checked again, or import without them: their cells are left blank on new tasks, and tasks being updated keep who they have now.')}</div>
                  {canAddPeople && people.some((person) => person.state === 'account') ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Label htmlFor="import-member-role">{t('Role for people added')}</Label>
                      <Select value={roleId} onValueChange={setRoleId}>
                        <SelectTrigger id="import-member-role" className="h-8 w-56">
                          <SelectValue placeholder={t('Choose a role')} />
                        </SelectTrigger>
                        <SelectContent>
                          {(roles.data ?? []).map((role) => (
                            <SelectItem key={role.id} value={role.id}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">{t('Choose one that can be given tasks.')}</span>
                    </div>
                  ) : null}
                  <table className="mt-2 w-full">
                    <tbody>
                      {people.map((person) => (
                        <tr key={person.name} className="border-b border-border last:border-0">
                          <td className="p-1.5 pe-3 align-top font-medium" dir="auto">
                            {person.name}
                          </td>
                          <td className="p-1.5 pe-3 align-top text-muted-foreground">
                            {t('{count, plural, one {# row} other {# rows}}', { count: person.rows })} · {person.columns.map((column) => t(column)).join(', ')}
                          </td>
                          <td className="p-1.5 pe-3 align-top">
                            {person.state === 'account'
                              ? t('Has an account, but is not a member of this project')
                              : person.state === 'role'
                                ? t('A member, but their role cannot be given tasks')
                                : t('No account here')}
                          </td>
                          <td className="p-1.5 text-end align-top">
                            {person.state === 'account' && person.userId && canAddPeople ? (
                              <Button size="sm" variant="outline" disabled={!roleId || checking || adding !== null} loading={adding === person.userId} onClick={() => void addPerson(person)}>
                                <UserPlus className="h-4 w-4" />
                                {t('Add to project')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Button className="mt-2" size="sm" variant="outline" loading={checking} disabled={adding !== null} onClick={importWithoutPeople}>
                    {t('Import without them')}
                  </Button>
                </Alert>
              ) : null}
              {otherProblemCount > 0 ? (
                <Alert tone="danger" title={t('{count} problems to fix before importing', { count: formatNumber(otherProblemCount) })}>
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full">
                      <tbody>
                        {otherProblems.map((problem, index) => (
                          <tr key={index}>
                            <td className="pe-3 align-top font-mono">{t('Line {row}', { row: problem.row })}</td>
                            <td className="pe-3 align-top">{problem.column ? t(problem.column) : ''}</td>
                            <td className="align-top">{problem.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Alert>
              ) : null}
              {started ? (
                <div className="space-y-1.5">
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <div>
                    {t('{created} of {toCreate} created, {updated} of {toUpdate} updated, {failed} failed', {
                      created: formatNumber(view.created),
                      toCreate: formatNumber(view.toCreate),
                      updated: formatNumber(view.updated),
                      toUpdate: formatNumber(view.toUpdate),
                      failed: formatNumber(view.failed),
                    })}
                    {' · '}
                    {t('{linked} dependencies added, {unlinked} removed', { linked: formatNumber(view.linked), unlinked: formatNumber(view.unlinked) })}
                    {time && time.entries > 0 ? ` · ${t('{logged} of {count} time entries logged', { logged: formatNumber(time.logged), count: formatNumber(time.entries) })}` : ''}
                    {view.status === 'cancelled' ? ` · ${t('Cancelled: resume to carry on.')}` : ''}
                    {view.status === 'failed' ? ` · ${t('Stopped: resume to carry on.')}` : ''}
                  </div>
                </div>
              ) : null}
              {view.errorCount > 0 ? (
                <div className="max-h-40 overflow-y-auto">
                  {view.errors.map((error, index) => (
                    <div key={index}>
                      {error.row > 0 ? `${t('Line {row}', { row: error.row })}: ` : ''}
                      {error.message}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {view?.status === 'running' ? (
            <Button variant="outline" onClick={() => void cancel()}>
              {t('Cancel import')}
            </Button>
          ) : null}
          {!view || view.problemCount > 0 ? (
            <Button disabled={!projectId || !file} loading={checking} onClick={() => void check()}>
              <Upload className="h-4 w-4" />
              {t('Check the file')}
            </Button>
          ) : view.canRun ? (
            <Button onClick={() => void run()}>{runLabel(view)}</Button>
          ) : view.status === 'done' || work === 0 ? (
            <>
              {view.status === 'done' ? (
                <Button variant="outline" onClick={() => void downloadSheet()}>
                  <Download className="h-4 w-4" />
                  {t('Download the updated sheet')}
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>{t('Close')}</Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
