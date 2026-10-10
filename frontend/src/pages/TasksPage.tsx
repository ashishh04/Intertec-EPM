import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryWorkspace } from '@/components/tasks/QueryWorkspace';
import { Button } from '@/components/ui/button';
import { useUI } from '@/providers/UIProvider';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';

/** Cross-project work-package explorer. */
export default function TasksPage() {
  const { canAnywhere } = useAuth();
  const { openTaskDrawer } = useUI();

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Tasks')}
        description={t('Every work package across the portfolio, with filtering and bulk actions.')}
        actions={
          <Button onClick={() => openTaskDrawer()} disabled={!canAnywhere('task:create')}>
            <Plus className="h-4 w-4" />
            {t('New Task')}
          </Button>
        }
      />
      <QueryWorkspace />
    </div>
  );
}
