import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Clock, Mail, Settings } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import { EmptyState } from '@/components/common/EmptyState';
import { FactList } from '@/components/common/FactList';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label, FieldHint } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/providers/AuthProvider';
import { useTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { usePreferences, type Preferences } from '@/hooks/usePreferences';
import { formatNumber } from '@/lib/utils';
import type { ID, EpmProject } from '@/types';

/**
 * The switches shown here drive the same keys as Settings › Notifications, so
 * flipping one in either place is reflected in the other. The in-app rows and
 * the one email master switch; the per-type email choices stay in Settings.
 */
type ProfileToggle =
  | {
      section: 'notifications';
      key: keyof Preferences['notifications'];
      label: string;
      hint: string;
    }
  | { section: 'email'; key: 'enabled'; label: string; hint: string };

const PREFERENCES: ProfileToggle[] = [
  {
    section: 'notifications',
    key: 'mentions',
    label: 'Mentions',
    hint: 'When someone mentions you in a comment.',
  },
  {
    section: 'notifications',
    key: 'assigned',
    label: 'Assignments',
    hint: 'When work is assigned to you.',
  },
  {
    section: 'notifications',
    key: 'dueReminders',
    label: 'Deadline reminders',
    hint: 'Two days before a due date.',
  },
  {
    section: 'notifications',
    key: 'digest',
    label: 'Daily digest',
    hint: 'A morning summary, in your notifications feed.',
  },
  {
    section: 'email',
    key: 'enabled',
    label: 'Send me email',
    hint: 'Off means no email of any kind.',
  },
];

/** The signed-in user's profile, work and preferences. */
export default function ProfilePage() {
  const { user } = useAuth();
  const tasksQuery = useTasks({ assigneeId: user?.id, pageSize: 12, sortBy: 'dueDate' });
  const projectsQuery = useProjects();
  const activityQuery = useActivity({ limit: 15 });
  const users = useUserMap();
  const { preferences, update } = usePreferences();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const myActivity = useMemo(
    () => (activityQuery.data ?? []).filter((entry) => entry.actorId === user?.id),
    [activityQuery.data, user?.id],
  );

  if (!user) {
    return <PageSkeleton />;
  }

  const assignedTotal = tasksQuery.data?.total ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Profile"
        description="Your identity, work and notification preferences."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/settings">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <UserAvatar user={user} size="xl" showStatus />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold tracking-tight">{user.name}</h2>
            <p className="text-xs text-muted-foreground">{user.role}</p>

            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                <dt className="sr-only">Department</dt>
                <dd>{user.department}</dd>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Mail className="h-3.5 w-3.5" aria-hidden />
                <dt className="sr-only">Email</dt>
                <dd className="truncate font-mono text-2xs">{user.email}</dd>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                <dt className="sr-only">Timezone</dt>
                <dd>{user.timezone || 'Timezone not set'}</dd>
              </div>
            </dl>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="work">
        <TabsList>
          <TabsTrigger value="work">
            Assigned Work
            {assignedTotal > 0 ? (
              <span className="ml-1.5 font-mono text-2xs text-muted-foreground">
                {formatNumber(assignedTotal)}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="activity">My Activity</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="mt-4">
          <Card className="overflow-hidden">
            <QueryBoundary
              isLoading={tasksQuery.isLoading}
              isError={tasksQuery.isError}
              onRetry={() => tasksQuery.refetch()}
              errorTitle="Unable to load your work"
              skeleton={<TaskListSkeleton rows={6} />}
              isEmpty={(tasksQuery.data?.items.length ?? 0) === 0}
              empty={<EmptyState size="inline" title="No assigned work" description="Your queue is clear." />}
            >
              <div className="divide-y divide-border">
                {(tasksQuery.data?.items ?? []).map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    project={projectsById.get(task.projectId)}
                    assignee={user}
                  />
                ))}
              </div>
            </QueryBoundary>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardContent className="p-5">
              <QueryBoundary
                isLoading={activityQuery.isLoading}
                isError={activityQuery.isError}
                onRetry={() => activityQuery.refetch()}
                errorTitle="Unable to load activity"
                skeleton={<ActivityTimelineSkeleton rows={6} />}
                isEmpty={myActivity.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    title="No recent activity"
                    description="Your updates will appear here as you work."
                  />
                }
              >
                <ActivityTimeline entries={myActivity} users={users} limit={12} />
              </QueryBoundary>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preferences" className="mt-4">
          <Card className="max-w-2xl">
            <CardHeader variant="compact">
              <CardTitle>Working preferences</CardTitle>
              <CardDescription>What the directory knows about you.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              <FactList
                facts={[
                  { label: 'Timezone', value: user.timezone, mono: false },
                  { label: 'Department', value: user.department, mono: false },
                  { label: 'Role', value: user.role, mono: false },
                  {
                    label: 'Account status',
                    value: <span className="capitalize">{user.status}</span>,
                    mono: false,
                  },
                ]}
              />

              <Alert tone="neutral">
                Identity details are managed by your organisation directory and synchronised into
                EPM. Contact the IT service desk to change your name, role or department.
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <Card className="max-w-2xl">
            <CardHeader variant="compact">
              <CardTitle>Notification preferences</CardTitle>
              <CardDescription>Saved as you change them, and the same on every device.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {PREFERENCES.map((preference) => {
                  const id = `pref-${preference.section}-${preference.key}`;
                  const checked =
                    preference.section === 'email'
                      ? preferences.email.enabled
                      : preferences.notifications[preference.key];
                  return (
                    <div key={id} className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0 space-y-0.5">
                        <Label htmlFor={id}>{preference.label}</Label>
                        <FieldHint>{preference.hint}</FieldHint>
                      </div>
                      <Switch
                        id={id}
                        checked={checked}
                        onCheckedChange={(value) =>
                          preference.section === 'email'
                            ? update('email', 'enabled', value)
                            : update('notifications', preference.key, value)
                        }
                      />
                    </div>
                  );
                })}
                <div className="px-4 py-2.5">
                  <FieldHint>
                    Choose which kinds of email you get in{' '}
                    <Link
                      to="/settings?section=notifications"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Settings
                    </Link>
                    .
                  </FieldHint>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
