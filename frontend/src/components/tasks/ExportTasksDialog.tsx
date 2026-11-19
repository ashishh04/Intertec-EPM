import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { t } from '@/lib/i18n';
import { apiClient } from '@/services/api/client';
import type { TaskExportFormats } from '@/types';

/**
 * Exports a project's epics, tasks, subtasks and milestones as CSV or Excel,
 * in the columns the import reads. Imported into the same project, an edited
 * file changes only what was edited (each row's ID, WP and its number, names
 * its task); imported into another project, it makes a copy.
 *
 * Or as a Microsoft Project plan: the .mpp itself, where the server has the
 * licence its writer needs (it says so, and why not, before anyone chooses
 * it), or Microsoft Project XML, which Microsoft Project opens and saves as
 * .mpp. Each task links back to its work package, so either plan can be
 * imported again to update them.
 */

type ExportFormat = 'csv' | 'xlsx' | 'mpp' | 'msproject';
const EXTENSION: Record<ExportFormat, string> = { csv: 'csv', xlsx: 'xlsx', mpp: 'mpp', msproject: 'xml' };

/** Why the server writes no .mpp, in words for the person exporting. */
function mppUnavailableText(reason: TaskExportFormats['mppUnavailable']): string {
  switch (reason) {
    case 'no-licence':
      return t('Microsoft Project files (.mpp) need their licence installed on this server: ask an administrator. Until then, Microsoft Project XML opens in Microsoft Project, which saves it as .mpp.');
    case 'licence-refused':
      return t('The licence for Microsoft Project files on this server did not load: ask an administrator. Until then, Microsoft Project XML opens in Microsoft Project, which saves it as .mpp.');
    default:
      return t('This server cannot write Microsoft Project files (.mpp). Microsoft Project XML opens in Microsoft Project, which saves it as .mpp.');
  }
}

export function ExportTasksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string>();
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [closed, setClosed] = useState(true);
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })), [projects.data]);
  const identifier = (projects.data ?? []).find((project) => project.id === projectId)?.identifier ?? `project-${projectId}`;
  // Whether this server writes .mpp: asked when the dialog opens, not on every render.
  const formats = useQuery({
    queryKey: ['task-export-formats'] as const,
    queryFn: () => apiClient.get<TaskExportFormats>('/task-exports/formats'),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const mppReady = formats.data?.mpp === true;

  const download = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const blob = await apiClient.download(`/projects/${projectId}/task-exports`, { format, closed: String(closed) }, 300_000);
      saveBlob(blob, `${identifier}-tasks-${new Date().toISOString().slice(0, 10)}.${EXTENSION[format]}`);
      onOpenChange(false);
    } catch (error) {
      toast.error(t('The export failed'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Export tasks')}</DialogTitle>
          <DialogDescription>{t('Every epic, task, subtask and milestone of a project, as Excel or CSV in the columns Import reads, or as a Microsoft Project plan.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="export-project" required>
              {t('Project')}
            </Label>
            <ComboSelect id="export-project" label={t('Project')} options={options} value={projectId} onChange={setProjectId} />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="export-format">{t('Format')}</Label>
              <Select value={format} onValueChange={(value) => setFormat(value as ExportFormat)}>
                <SelectTrigger id="export-format" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xlsx">{t('Excel (.xlsx)')}</SelectItem>
                  <SelectItem value="csv">{t('CSV')}</SelectItem>
                  <SelectItem value="mpp" disabled={!mppReady}>
                    {t('Microsoft Project (.mpp)')}
                  </SelectItem>
                  <SelectItem value="msproject">{t('Microsoft Project XML (.xml)')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pb-2 text-xs">
              <Switch checked={closed} onCheckedChange={setClosed} />
              {t('Include closed work')}
            </label>
          </div>
          {formats.data && !mppReady ? (
            <p className="text-2xs leading-relaxed text-muted-foreground" data-testid="mpp-unavailable">
              {mppUnavailableText(formats.data.mppUnavailable)}
            </p>
          ) : null}
          {format === 'mpp' || format === 'msproject' ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <ul className="list-disc space-y-1 ps-4">
                {format === 'mpp' ? (
                  <li>{t('A Microsoft Project file: it opens in Microsoft Project as it is, with the outline, dates, dependencies, work, progress, notes, assignees and the working calendar.')}</li>
                ) : (
                  <>
                    <li>{t('Open the file in Microsoft Project (File → Open, XML Format). To keep it as a Project file, choose File → Save As → Project (*.mpp).')}</li>
                    <li>{t('It holds the outline, dates, dependencies, work, progress, notes, assignees and the working calendar. Each task links back to its task here.')}</li>
                  </>
                )}
                <li>{t('Save the edited plan as .mpp or XML and import it into the same project: the tasks it came from are updated, and new ones are added.')}</li>
              </ul>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <ul className="list-disc space-y-1 ps-4">
                <li>{t('To change many tasks at once: edit this file and import it into the same project — as often as you like. Only the cells you change are updated; nothing is duplicated.')}</li>
                <li>{t('You can edit Subject, Description, Type, dates, Estimated hours, Done %, Assignee, Accountable, Status, Priority, Version, Category, Story points, Manual scheduling, Parent ID, Predecessors and the project’s own fields.')}</li>
                <li>{t('Keep the ID column as it is (WP and the task’s number): it is how Import finds each task. Add new rows with your own IDs, or none.')}</li>
                <li>{t('Work package, Spent hours, Created and Updated are for reading: Import ignores them. Spent hours come from logged time.')}</li>
                <li>{t('Imported into another project, the file makes a copy of these tasks there.')}</li>
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button disabled={!projectId || (format === 'mpp' && !mppReady)} loading={busy} onClick={() => void download()}>
            <Download className="h-4 w-4" />
            {t('Download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
