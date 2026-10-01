import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ListTree } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { PriorityBadge, StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useTaskHierarchy } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { cn } from '@/lib/utils';
import type { EpmTask, EpmUser, ID } from '@/types';

/**
 * Where a work package sits in the delivery tree.
 *
 * Two views of the same relationship, because they answer different questions.
 * The trail says what this item is part of — an epic, then the feature under
 * it — and belongs beside the title where it is read before the work itself.
 * The sub-item list says what is part of this, and is a working list: status,
 * assignee and progress per child, because a parent's real state is its
 * children's.
 *
 * Both come from one request. See `GET /tasks/:id/hierarchy`.
 */

interface TaskHierarchyProps {
  taskId: ID;
}

/** The ancestor chain, root first, as a breadcrumb. */
export function HierarchyTrail({ taskId }: TaskHierarchyProps) {
  const { data } = useTaskHierarchy(taskId);
  const ancestors = data?.ancestors ?? [];

  if (ancestors.length === 0) return null;

  return (
    <nav aria-label="Work package hierarchy" className="flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground">Hierarchy:</span>
      {ancestors.map((ancestor, index) => (
        <Fragment key={ancestor.id}>
          {index > 0 ? (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
          <Link
            to={`/tasks/${ancestor.id}`}
            className="max-w-[16rem] truncate rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={ancestor.subject}
          >
            {ancestor.subject}
          </Link>
        </Fragment>
      ))}
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
    </nav>
  );
}

/** Direct children, with enough state to be worked from rather than just counted. */
export function TaskSubItems({ taskId }: TaskHierarchyProps) {
  const { data, isLoading, isError } = useTaskHierarchy(taskId);
  const users = useUserMap();

  const children = data?.children ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <ListTree className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Sub-items
          {children.length > 0 ? (
            <span className="font-mono text-2xs text-muted-foreground">{children.length}</span>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className={cn(children.length > 0 ? 'p-0' : 'pt-4')}>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            size="inline"
            title="Unable to load sub-items"
            description="The delivery system did not answer for this work package's children."
          />
        ) : children.length === 0 ? (
          <EmptyState
            size="inline"
            title="No sub-items"
            description="Work broken out under this one appears here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {children.map((child) => (
              <SubItemRow key={child.id} task={child} users={users} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SubItemRow({ task, users }: { task: EpmTask; users: Map<ID, EpmUser> }) {
  const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;

  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="w-20 shrink-0 font-mono text-2xs text-muted-foreground">{task.key}</span>

        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task.subject}>
          {task.subject}
        </span>

        <TypeBadge type={task.type} label={task.typeRef.name} />
        <StatusBadge status={task.statusCategory} label={task.status.name} />
        <PriorityBadge priority={task.priority} label={task.priorityRef.name} />

        {/* A parent's progress is its children's, so each child shows its own. */}
        <ProgressBar value={task.progress} className="hidden w-16 shrink-0 sm:block" />

        <span className="w-6 shrink-0">
          {assignee ? <UserAvatar user={assignee} size="sm" /> : null}
        </span>
      </Link>
    </li>
  );
}
