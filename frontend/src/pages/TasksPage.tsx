import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryWorkspace } from '@/components/tasks/QueryWorkspace';
import { Button } from '@/components/ui/button';
import { useUI } from '@/providers/UIProvider';
import { useAuth } from '@/providers/AuthProvider';

/** Cross-project work-package explorer. */
export default function TasksPage() {
  const { canAnywhere } = useAuth();
  const { openTaskDrawer } = useUI();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks"
        description="Every work package across the portfolio, with filtering and bulk actions."
        actions={
          <Button onClick={() => openTaskDrawer()} disabled={!canAnywhere('task:create')}>
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        }
      />
      <QueryWorkspace />
    </div>
  );
}
