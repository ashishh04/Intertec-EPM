import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { env } from '@/config/env';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { intlLocale, t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { apiClient } from '@/services/api/client';
import type { TaskImportView } from '@/types';

/**
 * Imports epics, tasks, subtasks and milestones from a CSV: download the
 * template, fill it in (or export from another tool), upload it to have every
 * row checked, then import. Large files — 10,000 rows and more — run in the
 * background with progress, and can be resumed if they stop.
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
        if (next.status === 'done') toast.success(t('{count} work packages imported', { count: formatNumber(next.created) }));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [view?.id, view?.status, client]);

  const options = useMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })), [projects.data]);

  const downloadTemplate = async () => {
    if (!projectId) return;
    try {
      saveBlob(await apiClient.download(`/projects/${projectId}/task-imports/template`), 'epm-task-import-template.csv');
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

  const done = view ? view.created + view.failed : 0;
  const percent = view && view.total > 0 ? Math.min(100, Math.round((done / view.total) * 100)) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Import tasks from a CSV')}</DialogTitle>
          <DialogDescription>
            {t('Epics, tasks, subtasks and milestones, with dates, estimates, assignees, status and dependencies. Every row is checked before anything is created.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="import-project" required>
              {t('Project')}
            </Label>
            <ComboSelect id="import-project" label={t('Project')} options={options} value={projectId} onChange={(value) => { setProjectId(value); setView(null); }} disabled={view?.status === 'running'} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="import-file">{t('CSV file')}</Label>
              <Input id="import-file" type="file" accept=".csv,text/csv" className="w-80" disabled={view?.status === 'running'} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setView(null); }} />
            </div>
            <Button variant="outline" disabled={!projectId} onClick={() => void downloadTemplate()}>
              <Download className="h-4 w-4" />
              {t('Template')}
            </Button>
          </div>
          <FieldHint>
            {t('Columns: ID, Parent ID, Type, Subject, Description, Start date, Due date, Estimated hours, Assignee, Status, Priority, Version, Predecessors. A row goes under another by its Parent ID — epic, task, subtask, as deep as needed — and follows the rows its Predecessors name.')}
          </FieldHint>

          {view ? (
            <div className="space-y-3 rounded-md border border-border p-3 text-xs">
              <div className="font-medium" dir="auto">
                {view.fileName}: {t('{count} rows', { count: formatNumber(view.total) })} ·{' '}
                {Object.entries(view.byType)
                  .map(([type, count]) => `${type} ${formatNumber(count)}`)
                  .join(' · ')}{' '}
                · {t('{levels} levels', { levels: view.levels })} · {t('{count} dependencies', { count: formatNumber(view.relations) })}
              </div>
              {view.problemCount > 0 ? (
                <Alert tone="danger" title={t('{count} problems to fix before importing', { count: formatNumber(view.problemCount) })}>
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full">
                      <tbody>
                        {view.problems.map((problem, index) => (
                          <tr key={index}>
                            <td className="pe-3 align-top font-mono">{t('Line {row}', { row: problem.row })}</td>
                            <td className="pe-3 align-top">{problem.column ?? ''}</td>
                            <td className="align-top">{problem.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Alert>
              ) : null}
              {view.status === 'running' || view.status === 'done' || view.status === 'cancelled' || view.status === 'failed' ? (
                <div className="space-y-1.5">
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <div>
                    {t('{created} of {total} created, {failed} failed, {linked} dependencies linked', {
                      created: formatNumber(view.created),
                      total: formatNumber(view.total),
                      failed: formatNumber(view.failed),
                      linked: formatNumber(view.linked),
                    })}
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
            <Button onClick={() => void run()}>
              {view.status === 'checked' ? t('Import {count} rows', { count: formatNumber(view.total) }) : t('Resume the import')}
            </Button>
          ) : view.status === 'done' ? (
            <Button onClick={() => onOpenChange(false)}>{t('Close')}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
