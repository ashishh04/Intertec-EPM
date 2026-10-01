import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Bell, CheckCheck, FolderKanban } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { NotificationItem } from '@/components/common/NotificationItem';
import { Pagination } from '@/components/common/Pagination';
import { Badge, CountBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
} from '@/hooks/useNotifications';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { NOTIFICATION_REASON_META } from '@/lib/domain';
import { cn, formatNumber, pluralize } from '@/lib/utils';
import type { EpmNotification, ID, NotificationReason } from '@/types';

/**
 * The notification centre.
 *
 * Three ways of narrowing the same list, in the order people reach for them:
 * unread or everything, then which project, then why it was raised. Reason rather
 * than display category — "mentioned" and "watching" are what somebody is
 * actually filtering for, and they map one-for-one onto the switches in Settings,
 * so a filter cannot describe something the settings call by another name.
 *
 * Grouping by project is a filter, not a sectioned list. Sections read well until
 * a reader wants "everything in this project", at which point they are scrolling
 * to find a heading; a project rail with unread counts answers both.
 */

type ReadFilter = 'unread' | 'all';

/** The reasons worth a chip, in the order they matter to a reader. */
const REASON_ORDER: NotificationReason[] = [
  'mentioned',
  'assignee',
  'accountable',
  'watcher',
  'dateAlert',
  'reminder',
  'shared',
  'commented',
  'epm',
];

const ALL_PROJECTS = '__all__';

export default function NotificationsPage() {
  const [read, setRead] = useState<ReadFilter>('unread');
  const [reason, setReason] = useState<NotificationReason | 'all'>('all');
  const [project, setProject] = useState<string>(ALL_PROJECTS);

  const notificationsQuery = useNotifications();
  const projectsQuery = useProjects();
  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();
  const users = useUserMap();

  const notifications = notificationsQuery.data ?? [];
  const unread = useMemo(
    () => notifications.filter((notification) => !notification.read),
    [notifications],
  );

  const projectNames = useMemo(
    () => new Map<ID, string>((projectsQuery.data ?? []).map((item) => [item.id, item.name])),
    [projectsQuery.data],
  );

  /**
   * Unread per project, for the rail.
   *
   * Built from the unread set whatever the current filter, so the counts do not
   * change as somebody narrows the list — a rail whose numbers move when you
   * click one of its own entries is unreadable.
   */
  const unreadByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const notification of unread) {
      const key = notification.projectId ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [unread]);

  const visible = useMemo(() => {
    const base = read === 'unread' ? unread : notifications;
    return base.filter(
      (notification) =>
        (reason === 'all' || notification.reason === reason) &&
        (project === ALL_PROJECTS || (notification.projectId ?? '') === project),
    );
  }, [read, unread, notifications, reason, project]);

  /** Unread per reason, on the same basis as the project counts. */
  const unreadByReason = useMemo(() => {
    const counts = new Map<string, number>([['all', unread.length]]);
    for (const notification of unread) {
      counts.set(notification.reason, (counts.get(notification.reason) ?? 0) + 1);
    }
    return counts;
  }, [unread]);

  // Any filter change returns the reader to the first page.
  const paged = usePagination(visible, {
    pageSize: 15,
    resetKey: `${read}|${reason}|${project}`,
  });

  // Only the reasons that actually occur, so the chip row does not offer nine
  // filters on an instance that only ever produces three.
  const presentReasons = useMemo(() => {
    const seen = new Set(notifications.map((notification) => notification.reason));
    return REASON_ORDER.filter((candidate) => seen.has(candidate));
  }, [notifications]);

  const projectsWithUnread = useMemo(
    () => [...unreadByProject.entries()].sort((a, b) => b[1] - a[1]),
    [unreadByProject],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description="Everything addressed to you, and everything you are following."
        meta={
          unread.length > 0 ? (
            <Badge tone="danger" variant="solid" size="sm" className="rounded-full">
              {formatNumber(unread.length)} unread
            </Badge>
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

      <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        {/* Project rail */}
        <Card className="lg:sticky lg:top-20 lg:self-start">
          <CardHeader variant="compact">
            <CardTitle>By project</CardTitle>
          </CardHeader>
          <div className="p-2">
            <ul className="space-y-0.5">
              <ProjectRow
                label="Everything"
                count={unread.length}
                active={project === ALL_PROJECTS}
                onSelect={() => setProject(ALL_PROJECTS)}
              />
              {projectsWithUnread.map(([id, count]) => (
                <ProjectRow
                  key={id || 'none'}
                  label={
                    id ? (projectNames.get(id) ?? `Project ${id}`) : 'Not about a project'
                  }
                  count={count}
                  active={project === id}
                  onSelect={() => setProject(id)}
                />
              ))}
              {projectsWithUnread.length === 0 ? (
                <li className="px-2 py-1.5 text-2xs text-muted-foreground">
                  Nothing unread anywhere.
                </li>
              ) : null}
            </ul>
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={read} onValueChange={(value) => setRead(value as ReadFilter)}>
              <TabsList>
                <TabsTrigger value="unread">
                  Unread
                  <CountBadge count={unread.length} />
                </TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>

            {read === 'unread' && visible.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-2xs"
                loading={markRead.isPending}
                onClick={() =>
                  markRead.mutate(
                    visible.map((notification) => notification.id),
                    {
                      onSuccess: () =>
                        toast.success(
                          `Marked ${visible.length} ${pluralize(visible.length, 'notification')} as read`,
                        ),
                      onError: () => toast.error('Unable to update notifications'),
                    },
                  )
                }
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark these read
              </Button>
            ) : null}
          </div>

          {/* Reason chips */}
          {presentReasons.length > 1 ? (
            <div className="epm-scroll -mx-1 overflow-x-auto px-1">
              <div role="group" aria-label="Filter by reason" className="flex min-w-max gap-1.5">
                <ReasonChip
                  label="Any reason"
                  count={unreadByReason.get('all') ?? 0}
                  active={reason === 'all'}
                  onSelect={() => setReason('all')}
                />
                {presentReasons.map((candidate) => (
                  <ReasonChip
                    key={candidate}
                    label={NOTIFICATION_REASON_META[candidate].label}
                    count={unreadByReason.get(candidate) ?? 0}
                    active={reason === candidate}
                    onSelect={() => setReason(candidate)}
                  />
                ))}
              </div>
            </div>
          ) : null}

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
                  title={read === 'unread' ? 'You are all caught up' : 'Nothing here'}
                  description={
                    reason === 'all' && project === ALL_PROJECTS
                      ? 'Mentions, assignments and date alerts will appear here.'
                      : 'Nothing matches these filters. Widen them to see the rest.'
                  }
                />
              </Card>
            }
          >
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border">
                {paged.items.map((notification) => (
                  <li key={notification.id}>
                    <FeedRow
                      notification={notification}
                      projectName={
                        notification.projectId
                          ? projectNames.get(notification.projectId)
                          : undefined
                      }
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
      </div>
    </div>
  );
}

function ProjectRow({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-2xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'bg-primary-soft font-medium text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <FolderKanban className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 ? <CountBadge count={count} /> : null}
      </button>
    </li>
  );
}

function ReasonChip({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary/40 bg-primary-soft text-primary'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
      {count > 0 ? <CountBadge count={count} /> : null}
    </button>
  );
}

/**
 * One feed entry, with the reason and the project shown beside it.
 *
 * `NotificationItem` is reused for the body rather than replaced: it already
 * carries the icon, the actor and the link target, and is the same row the header
 * panel renders. What is added here is the context a full-page feed has room for
 * and a dropdown panel does not.
 */
function FeedRow({
  notification,
  projectName,
  users,
  onRead,
}: {
  notification: EpmNotification;
  projectName?: string;
  users: Parameters<typeof NotificationItem>[0]['users'];
  onRead: (id: ID) => void;
}) {
  const meta = NOTIFICATION_REASON_META[notification.reason];

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <Badge tone={meta.tone} size="sm">
          {meta.label}
        </Badge>
        {notification.projectId ? (
          <Link
            to={`/projects/${notification.projectId}`}
            className="text-2xs text-muted-foreground hover:underline"
          >
            {projectName ?? `Project ${notification.projectId}`}
          </Link>
        ) : null}
      </div>
      <NotificationItem notification={notification} users={users} onRead={onRead} />
    </div>
  );
}
