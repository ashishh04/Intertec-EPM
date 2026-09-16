import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/badge';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { NotificationItem } from '@/components/common/NotificationItem';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/useNotifications';
import { useUserMap } from '@/hooks/useUsers';
import { toast } from 'sonner';

/** Header notification bell with an inline preview of the newest items. */
export function NotificationPanel() {
  // Controlled, because every route in here is a client-side navigation. The
  // header outlives the route change, so nothing unmounts the popover and Radix
  // never learns the user has left — it has to be closed explicitly.
  const [open, setOpen] = useState(false);
  const { data: notifications, isLoading, isError, refetch } = useNotifications();
  const users = useUserMap();
  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();

  const items = notifications ?? [];
  const unread = items.filter((notification) => !notification.read).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 ? (
            <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[22rem] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Notifications</h2>
            <CountBadge count={unread} />
          </div>
          {unread > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-2xs"
              onClick={() =>
                markAllRead.mutate(undefined, {
                  onSuccess: () => toast.success('All notifications marked as read'),
                })
              }
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </Button>
          ) : null}
        </div>

        <div className="epm-scroll max-h-96 overflow-y-auto">
          {isLoading ? (
            <ListSkeleton rows={4} height="h-12" className="p-3" />
          ) : isError ? (
            // A failed fetch must not read as an empty inbox.
            <ErrorState
              size="inline"
              title="Notifications could not be loaded"
              description="Try again in a moment."
              onRetry={() => void refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              size="inline"
              icon={Bell}
              title="You are all caught up"
              description="New mentions, assignments and deadline alerts will appear here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.slice(0, 6).map((notification) => (
                // The whole row is a link; closing here covers it without
                // reaching into NotificationItem's own handler.
                <li key={notification.id} onClick={() => setOpen(false)}>
                  <NotificationItem
                    notification={notification}
                    users={users}
                    compact
                    onRead={(id) => markRead.mutate([id])}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border p-2">
          <Button asChild variant="ghost" size="sm" className="w-full text-2xs">
            <Link to="/notifications" onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
