import { useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { ExportTasksDialog } from '@/components/tasks/ExportTasksDialog';
import { ImportTasksDialog } from '@/components/tasks/ImportTasksDialog';
import { QueryWorkspace } from '@/components/tasks/QueryWorkspace';
import { Button } from '@/components/ui/button';
import { useUI } from '@/providers/UIProvider';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';

/** Cross-project work-package explorer. */
export default function TasksPage() {
  const { canAnywhere } = useAuth();
  const { openTaskDrawer } = useUI();
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Tasks')}
        description={t('Every work package across the portfolio, with filtering and bulk actions.')}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setExporting(true)}>
              <Download className="h-4 w-4" />
              {t('Export')}
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)} disabled={!canAnywhere('task:create')}>
              <Upload className="h-4 w-4" />
              {t('Import')}
            </Button>
            <Button onClick={() => openTaskDrawer()} disabled={!canAnywhere('task:create')}>
              <Plus className="h-4 w-4" />
              {t('New Task')}
            </Button>
          </div>
        }
      />
      <QueryWorkspace />
      <ImportTasksDialog open={importing} onOpenChange={setImporting} />
      <ExportTasksDialog open={exporting} onOpenChange={setExporting} />
    </div>
  );
}
