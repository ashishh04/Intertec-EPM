import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { PriorityBadge, StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Card } from '@/components/ui/card';
import { cn, describeDueDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { EpmProject, EpmTask, EpmUser, ID } from '@/types';

/**
 * The same result as the task table, as cards: type, title, project, status,
 * priority, who it is assigned to and when it is due, a card each. For reading
 * a short list at a glance; the table stays the place for columns, sorting
 * and bulk changes.
 */
export function TaskCardGrid({
  tasks,
  projects,
  users,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  hideProject,
  emptyAction,
}: {
  tasks: EpmTask[];
  projects: Map<ID, EpmProject>;
  users: Map<ID, EpmUser>;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  hideProject?: boolean;
  emptyAction?: { label: string; onClick: () => void };
}) {
  if (tasks.length === 0) {
    return (
      <Card>
        <EmptyState
          title={t('No tasks found')}
          description={t('Nothing matches the current filters. Adjust them, or create the first task.')}
          action={emptyAction}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {tasks.map((task) => {
          const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;
          const due = describeDueDate(task.dueDate, task.statusCategory === 'done');
          return (
            <li key={task.id}>
              <Card className="group relative flex h-full flex-col gap-3 p-4 transition-colors hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <TypeBadge type={task.type} label={task.typeRef.name} />
                  <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
                </div>
                {/* Stretched over the card, so the whole card opens the task. */}
                <Link
                  to={`/tasks/${task.id}`}
                  dir="auto"
                  className="line-clamp-2 text-sm font-medium text-foreground after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {task.subject}
                </Link>
                {!hideProject ? (
                  <p className="truncate text-2xs text-muted-foreground" dir="auto">
                    {projects.get(task.projectId)?.name ?? '—'}
                  </p>
                ) : null}
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={task.statusCategory} label={task.status.name} size="sm" />
                  <PriorityBadge priority={task.priority} label={task.priorityRef.name} />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                    <UserAvatarWithTooltip user={assignee} size="xs" />
                    <span className="truncate">{assignee?.name ?? t('Unassigned')}</span>
                  </span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 font-mono text-2xs',
                      due.tone === 'overdue'
                        ? 'font-medium text-danger'
                        : due.tone === 'today'
                          ? 'font-medium text-warning'
                          : 'text-muted-foreground',
                    )}
                  >
                    <CalendarDays className="h-3 w-3" aria-hidden />
                    {due.label}
                  </span>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <Card className="px-1">
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          pageSizeOptions={[15, 25, 50, 100]}
          itemLabel={t('task')}
          itemLabelPlural={t('tasks')}
        />
      </Card>
    </div>
  );
}
