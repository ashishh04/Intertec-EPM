import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace';
import { Button } from '@/components/ui/button';
import { useUI } from '@/providers/UIProvider';
import { ALL_TASK_STATUSES } from '@/lib/domain';
import type { TaskStatus } from '@/types';

/** Cross-project work-package explorer. */
export default function TasksPage() {
  const { openTaskDrawer } = useUI();
  const [searchParams] = useSearchParams();

  // Metric cards on the dashboard deep-link into a pre-filtered view.
  const statusParam = searchParams.get('status');
  const status = ALL_TASK_STATUSES.includes(statusParam as TaskStatus)
    ? [statusParam as TaskStatus]
    : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks"
        description="Every work package across the portfolio, with filtering and bulk actions."
        actions={
          <Button onClick={() => openTaskDrawer()}>
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        }
      />
      <TaskWorkspace initialFilters={{ status }} />
    </div>
  );
}
