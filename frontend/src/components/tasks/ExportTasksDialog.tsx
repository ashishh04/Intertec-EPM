import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { t } from '@/lib/i18n';
import { apiClient } from '@/services/api/client';

/**
 * Exports a project's epics, tasks, subtasks and milestones as CSV or Excel,
 * in the columns the import reads: edit the file and import it again, with
 * its hierarchy and dependencies intact.
 */
export function ExportTasksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string>();
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [closed, setClosed] = useState(true);
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })), [projects.data]);
  const identifier = (projects.data ?? []).find((project) => project.id === projectId)?.identifier ?? `project-${projectId}`;

  const download = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const blob = await apiClient.download(`/projects/${projectId}/task-exports`, { format, closed: String(closed) }, 300_000);
      saveBlob(blob, `${identifier}-tasks-${new Date().toISOString().slice(0, 10)}.${format}`);
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
          <DialogDescription>{t('Every epic, task, subtask and milestone of a project, in the same columns the import reads: edit the file and import it again.')}</DialogDescription>
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
              <Select value={format} onValueChange={(value) => setFormat(value as 'csv' | 'xlsx')}>
                <SelectTrigger id="export-format" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xlsx">{t('Excel (.xlsx)')}</SelectItem>
                  <SelectItem value="csv">{t('CSV')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pb-2 text-xs">
              <Switch checked={closed} onCheckedChange={setClosed} />
              {t('Include closed work')}
            </label>
          </div>
          <FieldHint>{t('Each row has an ID (WP and its number), its parent’s ID and the IDs it follows. The columns after Predecessors are for reading; the import ignores them.')}</FieldHint>
        </div>
        <DialogFooter>
          <Button disabled={!projectId} loading={busy} onClick={() => void download()}>
            <Download className="h-4 w-4" />
            {t('Download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
