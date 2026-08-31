import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Clock, Mail, Settings } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import { EmptyState } from '@/components/common/EmptyState';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/providers/AuthProvider';
import { useTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { toast } from 'sonner';
import type { ID, NexusProject } from '@/types';

const PREFERENCES = [
  { id: 'digest', label: 'Daily delivery digest', hint: 'A morning summary of what needs attention.' },
  { id: 'mentions', label: 'Email me on mentions', hint: 'Send an email when someone mentions you.' },
  { id: 'assignments', label: 'Notify on new assignments', hint: 'Alert me when work is assigned to me.' },
  { id: 'deadlines', label: 'Deadline reminders', hint: 'Remind me two days before a due date.' },
];

/** The signed-in user's profile, work and preferences. */
export default function ProfilePage() {
  const { user } = useAuth();
  const tasksQuery = useTasks({ assigneeId: user?.id, pageSize: 12, sortBy: 'dueDate' });
  const projectsQuery = useProjects();
  const activityQuery = useActivity({ limit: 15 });
  const users = useUserMap();

  const projectsById = useMemo(
    () => new Map<ID, NexusProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const myActivity = useMemo(
    () => (activityQuery.data ?? []).filter((entry) => entry.actorId === user?.id),
    [activityQuery.data, user?.id],
  );

  if (!user) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

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
        <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center">
          <UserAvatar user={user} size="xl" showStatus />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">{user.name}</h2>
              <Badge tone="primary" size="sm">
                {user.role}
              </Badge>
            </div>

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
                <dd>{user.timezone}</dd>
              </div>
            </dl>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="work">
        <TabsList>
          <TabsTrigger value="work">Assigned Work</TabsTrigger>
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
            <CardContent className="pt-5">
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
            <CardHeader className="border-b border-border">
              <CardTitle>Working preferences</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="nexus-eyebrow">Timezone</dt>
                  <dd className="mt-1 text-xs">{user.timezone}</dd>
                </div>
                <div>
                  <dt className="nexus-eyebrow">Department</dt>
                  <dd className="mt-1 text-xs">{user.department}</dd>
                </div>
                <div>
                  <dt className="nexus-eyebrow">Role</dt>
                  <dd className="mt-1 text-xs">{user.role}</dd>
                </div>
                <div>
                  <dt className="nexus-eyebrow">Account status</dt>
                  <dd className="mt-1 text-xs capitalize">{user.status}</dd>
                </div>
              </dl>

              <p className="rounded-lg border border-border bg-muted/60 p-3 text-2xs text-muted-foreground">
                Identity details are managed by your organisation directory and synchronised into
                Nexus. Contact the IT service desk to change your name, role or department.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <Card className="max-w-2xl">
            <CardHeader className="border-b border-border">
              <CardTitle>Notification preferences</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border pt-0">
              {PREFERENCES.map((preference) => (
                <div key={preference.id} className="flex items-start justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <Label htmlFor={`pref-${preference.id}`} className="text-xs">
                      {preference.label}
                    </Label>
                    <p className="mt-0.5 text-2xs text-muted-foreground">{preference.hint}</p>
                  </div>
                  <Switch
                    id={`pref-${preference.id}`}
                    defaultChecked={preference.id !== 'digest'}
                    onCheckedChange={(checked) =>
                      toast.success('Preference saved', {
                        description: `${preference.label} ${checked ? 'enabled' : 'disabled'}.`,
                      })
                    }
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
