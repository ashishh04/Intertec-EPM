import { Link } from 'react-router-dom';
import { AtSign, Bell, CalendarClock, FolderKanban, Server, UserPlus } from 'lucide-react';
import { cn, formatRelative } from '@/lib/utils';
import { NOTIFICATION_CATEGORY_META, TONE_SOFT } from '@/lib/domain';
import { UserAvatar } from './UserAvatar';
import type { ID, NexusNotification, NexusUser, NotificationCategory } from '@/types';

const CATEGORY_ICON: Record<NotificationCategory, typeof Bell> = {
  mention: AtSign,
  assignment: UserPlus,
  project_update: FolderKanban,
  deadline: CalendarClock,
  system: Server,
};

interface NotificationItemProps {
  notification: NexusNotification;
  users: Map<ID, NexusUser>;
  onRead?: (id: ID) => void;
  /** Dense variant used inside the header popover. */
  compact?: boolean;
  className?: string;
}

function targetFor(notification: NexusNotification): string {
  if (notification.taskId) return `/tasks/${notification.taskId}`;
  if (notification.projectId) return `/projects/${notification.projectId}`;
  return '/notifications';
}

/** One notification row, shared by the header panel and the full page. */
export function NotificationItem({
  notification,
  users,
  onRead,
  compact = false,
  className,
}: NotificationItemProps) {
  const meta = NOTIFICATION_CATEGORY_META[notification.category];
  const Icon = CATEGORY_ICON[notification.category];
  const actor = notification.actorId ? users.get(notification.actorId) : undefined;

  return (
    <Link
      to={targetFor(notification)}
      onClick={() => {
        if (!notification.read) onRead?.(notification.id);
      }}
      className={cn(
        'group flex gap-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        compact ? 'px-3 py-2.5' : 'px-4 py-3',
        notification.read ? 'hover:bg-muted/60' : 'bg-primary-soft/40 hover:bg-primary-soft/60',
        className,
      )}
    >
      <span className="relative shrink-0">
        {actor ? (
          <UserAvatar user={actor} size={compact ? 'sm' : 'default'} />
        ) : (
          <span
            className={cn(
              'flex items-center justify-center rounded-full border',
              TONE_SOFT[meta.tone],
              compact ? 'h-6 w-6' : 'h-8 w-8',
            )}
            aria-hidden
          >
            <Icon className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 text-xs leading-snug',
              notification.read ? 'text-muted-foreground' : 'font-medium text-foreground',
            )}
          >
            {notification.title}
          </p>
          {!notification.read ? (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          ) : null}
        </div>

        <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground">{notification.body}</p>

        <div className="mt-1 flex items-center gap-2">
          {notification.taskKey ? (
            <span className="font-mono text-2xs text-muted-foreground">{notification.taskKey}</span>
          ) : null}
          <time className="text-2xs text-muted-foreground/80">
            {formatRelative(notification.timestamp)}
          </time>
          <span className="sr-only">{notification.read ? 'Read' : 'Unread'}</span>
        </div>
      </div>
    </Link>
  );
}
