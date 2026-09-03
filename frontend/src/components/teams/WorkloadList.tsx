import { cn, formatHours, pluralize } from '@/lib/utils';
import { Pagination } from '@/components/common/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/common/UserAvatar';
import type { ID, EpmUser, TeamMemberWorkload } from '@/types';

/** Allocation above this reads as over-committed. */
const OVER_ALLOCATED = 90;
const UNDER_ALLOCATED = 55;

// `null` means the person has no capacity, so there is no ratio to describe.
// It is neither over nor under committed — it is unanswerable, and saying
// "Available" would be the opposite of the truth.
function toneFor(allocation: number | null) {
  if (allocation === null) return 'neutral' as const;
  if (allocation >= OVER_ALLOCATED) return 'danger' as const;
  if (allocation >= 75) return 'warning' as const;
  if (allocation <= UNDER_ALLOCATED) return 'neutral' as const;
  return 'success' as const;
}

function labelFor(allocation: number | null) {
  if (allocation === null) return 'No capacity set';
  if (allocation >= OVER_ALLOCATED) return 'Over capacity';
  if (allocation >= 75) return 'Near capacity';
  if (allocation <= UNDER_ALLOCATED) return 'Available';
  return 'Balanced';
}

interface WorkloadListProps {
  workloads: TeamMemberWorkload[];
  users: Map<ID, EpmUser>;
  /** Rows per page. The paginator hides itself when everything fits. */
  pageSize?: number;
  className?: string;
}

/**
 * Capacity vs. assigned work per person. The allocation bar is paired with an
 * explicit label so the state is not conveyed by colour alone.
 */
export function WorkloadList({ workloads, users, pageSize = 10, className }: WorkloadListProps) {
  // People with no capacity sort last: there is nothing to rank them by, and
  // treating null as zero would put them among the least busy.
  const sorted = [...workloads].sort((a, b) => (b.allocation ?? -1) - (a.allocation ?? -1));
  const paged = usePagination(sorted, { pageSize });

  return (
    <div className={className}>
    <ul className="divide-y divide-border">
      {paged.items.map((workload) => {
        const user = users.get(workload.userId);
        const tone = toneFor(workload.allocation);

        return (
          <li key={workload.userId} className="flex items-center gap-3 px-4 py-3">
            <UserAvatar user={user} size="default" showStatus />

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-xs font-medium">{user?.name ?? 'Unknown member'}</p>
                <span className="shrink-0 font-mono text-xs font-medium tabular-nums">
                  {workload.allocation === null ? '—' : `${workload.allocation}%`}
                </span>
              </div>
              <p className="mt-0.5 truncate text-2xs text-muted-foreground">{user?.role}</p>

              <div className="mt-1.5 flex items-center gap-2">
                <ProgressBar
                  // The bar is capped for display only; the figure beside it is
                  // the true percentage, so overallocation is still visible.
                  value={Math.min(100, workload.allocation ?? 0)}
                  tone={tone}
                  size="sm"
                  label={`${user?.name ?? 'Member'} allocation`}
                  className="flex-1"
                />
                <span
                  className={cn(
                    'shrink-0 text-2xs font-medium',
                    tone === 'danger'
                      ? 'text-danger'
                      : tone === 'warning'
                        ? 'text-warning'
                        : tone === 'success'
                          ? 'text-success'
                          : 'text-muted-foreground',
                  )}
                >
                  {labelFor(workload.allocation)}
                </span>
              </div>
            </div>

            <dl className="hidden shrink-0 gap-4 text-right sm:flex">
              <div>
                <dt className="epm-eyebrow">Assigned</dt>
                <dd className="font-mono text-xs tabular-nums">
                  {workload.assignedTasks} {pluralize(workload.assignedTasks, 'task')}
                </dd>
              </div>
              <div>
                <dt className="epm-eyebrow">Logged</dt>
                <dd className="font-mono text-xs tabular-nums">
                  {formatHours(workload.hoursLogged)} / {formatHours(workload.hoursCapacity)}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
    <Pagination
      page={paged.page}
      pageSize={paged.pageSize}
      total={paged.total}
      onPageChange={paged.setPage}
      itemLabel="member"
      className="border-t border-border"
    />
    </div>
  );
}

export function WorkloadListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
