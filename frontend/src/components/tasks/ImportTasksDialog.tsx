import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { env } from '@/config/env';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { intlLocale, t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { apiClient } from '@/services/api/client';
import type { TaskImportView } from '@/types';

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
  const client = useQueryClient();
  const [projectId, setProjectId] = useState<string>();
  const [file, setFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<TaskImportView | null>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setView(null);
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

  const options = useMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })), [projects.data]);

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

  const check = async () => {
    if (!projectId || !file) return;
    setChecking(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const response = await fetch(`${env.apiBaseUrl}/projects/${projectId}/task-imports`, {
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

  const work = view ? view.toCreate + view.toUpdate : 0;
  const done = view ? view.created + view.updated + view.failed : 0;
  const percent = work > 0 ? Math.min(100, Math.round((done / work) * 100)) : 0;
  const started = view && ['running', 'done', 'cancelled', 'failed'].includes(view.status);
  const clean = view && view.problemCount === 0;

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
            <ComboSelect id="import-project" label={t('Project')} options={options} value={projectId} onChange={(value) => { setProjectId(value); setView(null); }} disabled={view?.status === 'running'} />
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
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setView(null); }}
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
              {view.problemCount > 0 ? (
                <Alert tone="danger" title={t('{count} problems to fix before importing', { count: formatNumber(view.problemCount) })}>
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full">
                      <tbody>
                        {view.problems.map((problem, index) => (
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
