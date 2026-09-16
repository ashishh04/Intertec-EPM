import { SectionHeader } from '@/components/common/PageHeader';
import { TableCard } from '@/components/common/DataTable';
import { Pagination } from '@/components/common/Pagination';
import { TaskRow } from '@/components/tasks/TaskRow';
import { usePagination } from '@/hooks/usePagination';
import { formatNumber, pluralize } from '@/lib/utils';
import type { EpmProject, EpmTask, EpmUser, ID } from '@/types';

/**
 * The sprint's work packages as a paged list under the board. The board is
 * for moving work; this is for scanning it, and for keyboard and screen-reader
 * users the drag columns cannot serve.
 */
export function SprintWorkList({
  tasks,
  users,
  projects,
  resetKey,
  pageSize = 10,
}: {
  tasks: EpmTask[];
  users: Map<ID, EpmUser>;
  projects?: Map<ID, EpmProject>;
  resetKey: string;
  pageSize?: number;
}) {
  const paged = usePagination(tasks, { pageSize, resetKey });

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Sprint work"
        description={`${formatNumber(tasks.length)} ${pluralize(tasks.length, 'task')} committed`}
      />
      <TableCard
        footer={
          <Pagination
            page={paged.page}
            pageSize={paged.pageSize}
            total={paged.total}
            onPageChange={paged.setPage}
            onPageSizeChange={paged.setPageSize}
            itemLabel="task"
          />
        }
      >
        <div className="divide-y divide-border">
          {paged.items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              project={projects?.get(task.projectId)}
              assignee={task.assigneeId ? users.get(task.assigneeId) : undefined}
            />
          ))}
        </div>
      </TableCard>
    </section>
  );
}
