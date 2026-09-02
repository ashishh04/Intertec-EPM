import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Bell, CheckCheck } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { NotificationItem } from '@/components/common/NotificationItem';
import { Pagination } from '@/components/common/Pagination';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/useNotifications';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { NOTIFICATION_CATEGORY_META } from '@/lib/domain';
import type { NotificationCategory } from '@/types';

type Filter = 'all' | NotificationCategory;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mention', label: 'Mentions' },
  { value: 'assignment', label: 'Assignments' },
  { value: 'project_update', label: 'Project Updates' },
  { value: 'deadline', label: 'Deadlines' },
  { value: 'system', label: 'System' },
];

/** Notification centre with category filtering and read management. */
export default function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const notificationsQuery = useNotifications();
  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();
  const users = useUserMap();

  const notifications = notificationsQuery.data ?? [];
  const unread = notifications.filter((notification) => !notification.read);

  const visible = useMemo(
    () =>
      filter === 'all'
        ? notifications
        : notifications.filter((notification) => notification.category === filter),
    [notifications, filter],
  );

  // Switching category returns the reader to the first page.
  const paged = usePagination(visible, { pageSize: 15, resetKey: filter });

  const counts = useMemo(() => {
    const map = new Map<Filter, number>([['all', unread.length]]);
    for (const notification of unread) {
      map.set(notification.category, (map.get(notification.category) ?? 0) + 1);
    }
    return map;
  }, [unread]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description="Mentions, assignments, deadlines and system events."
        meta={
          unread.length > 0 ? (
            <span className="rounded-full bg-danger px-2 py-0.5 text-2xs font-semibold text-danger-foreground">
              {unread.length} unread
            </span>
          ) : null
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={unread.length === 0}
            onClick={() =>
              markAllRead.mutate(undefined, {
                onSuccess: () => toast.success('All notifications marked as read'),
                onError: () => toast.error('Unable to update notifications'),
              })
            }
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all as read
          </Button>
        }
      />

      <div className="epm-scroll overflow-x-auto">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList variant="underline" className="min-w-max">
            {FILTERS.map((item) => {
              const count = counts.get(item.value) ?? 0;
              return (
                <TabsTrigger key={item.value} value={item.value} variant="underline">
                  {item.label}
                  {count > 0 ? (
                    <span className="rounded-full bg-danger px-1.5 text-[10px] font-semibold text-danger-foreground">
                      {count}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>

      <QueryBoundary
        isLoading={notificationsQuery.isLoading}
        isError={notificationsQuery.isError}
        error={notificationsQuery.error}
        onRetry={() => notificationsQuery.refetch()}
        errorTitle="Unable to load notifications"
        skeleton={
          <Card className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex gap-3 p-4">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </Card>
        }
        isEmpty={visible.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={Bell}
              title="You are all caught up"
              description={
                filter === 'all'
                  ? 'New mentions, assignments and deadline alerts will appear here.'
                  : `No ${NOTIFICATION_CATEGORY_META[filter as NotificationCategory].label.toLowerCase()} notifications.`
              }
            />
          </Card>
        }
      >
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {paged.items.map((notification) => (
              <li key={notification.id}>
                <NotificationItem
                  notification={notification}
                  users={users}
                  onRead={(id) => markRead.mutate([id])}
                />
              </li>
            ))}
          </ul>
          <Pagination
            page={paged.page}
            pageSize={paged.pageSize}
            total={paged.total}
            onPageChange={paged.setPage}
            onPageSizeChange={paged.setPageSize}
            pageSizeOptions={[15, 30, 50]}
            itemLabel="notification"
            className="border-t border-border"
          />
        </Card>
      </QueryBoundary>
    </div>
  );
}
