import { useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileText, LogOut, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { env } from '@/config/env';
import { saveBlob } from '@/lib/download';
import { intlLocale, t } from '@/lib/i18n';
import { formatDateTime, formatNumber, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { apiClient } from '@/services/api/client';
import type { PortalApproval, PortalDocument, PortalHome, PortalProjectView, PortalTaskRow, PortalTaskView } from '@/types';

/**
 * The external portal (Module 17: BR-611): what a client or a vendor sees
 * instead of EPM. Only their projects, and in each only what their role
 * allows; no internal navigation at all. Its API is the only one the server
 * lets them reach.
 */
export default function PortalApp() {
  return (
    <PortalLayout>
      <Routes>
        <Route path="/portal" element={<PortalHomePage />} />
        <Route path="/portal/projects/:id" element={<PortalProjectPage />} />
        <Route path="/portal/tasks/:id" element={<PortalTaskPage />} />
        <Route path="/portal/approvals" element={<PortalApprovalsPage />} />
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </PortalLayout>
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);
const HEALTH_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { healthy: 'success', warning: 'warning', critical: 'danger' };
const healthLabel = (health: string) => (health === 'healthy' ? t('On track') : health === 'warning' ? t('At risk') : health === 'critical' ? t('Off track') : t('Not assessed'));

function PortalLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/portal" className="flex items-center gap-3">
            <span className="text-base font-semibold">EPM</span>
            <span className="text-xs text-muted-foreground">{t('Client portal')}</span>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <span dir="auto">{user?.name}</span>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" />
              {t('Sign out')}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-5 px-6 py-6">{children}</main>
    </div>
  );
}

function PortalHomePage() {
  const home = useQuery({ queryKey: ['portal', 'home'], queryFn: () => apiClient.get<PortalHome>('/portal/home') });
  return (
    <QueryBoundary isLoading={home.isLoading} isError={home.isError} error={home.error} onRetry={() => void home.refetch()} errorTitle={t('The portal could not be loaded')} skeleton={<ListSkeleton rows={4} />}>
      {home.data ? (
        <div className="space-y-5">
          <div>
            <h1 className="text-xl font-semibold">{t('Welcome, {name}', { name: home.data.userName })}</h1>
            <p className="text-xs text-muted-foreground">{t('The projects shared with you.')}</p>
          </div>
          {home.data.approvals > 0 ? (
            <Card>
              <CardContent className="flex items-center justify-between pt-4 text-sm">
                <span>{t('{count} approvals are waiting for you.', { count: home.data.approvals })}</span>
                <Button asChild size="sm">
                  <Link to="/portal/approvals">{t('Open')}</Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {home.data.projects.map((project) => (
              <Link key={project.id} to={`/portal/projects/${project.id}`}>
                <Card className="transition-colors hover:border-primary">
                  <CardHeader variant="compact">
                    <CardTitle dir="auto">{project.name}</CardTitle>
                    <CardDescription>{project.roleName}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
            {home.data.projects.length === 0 ? <p className="text-xs text-muted-foreground">{t('No projects are shared with you yet.')}</p> : null}
          </div>
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function PortalProjectPage() {
  const { id } = useParams<{ id: string }>();
  const project = useQuery({ queryKey: ['portal', 'project', id], queryFn: () => apiClient.get<PortalProjectView>(`/portal/projects/${id}`) });
  const can = (permission: string) => project.data?.permissions.includes(permission as never) ?? false;
  return (
    <QueryBoundary isLoading={project.isLoading} isError={project.isError} error={project.error} onRetry={() => void project.refetch()} errorTitle={t('The project could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
      {project.data ? (
        <div className="space-y-5">
          <Link to="/portal" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('All projects')}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold" dir="auto">
                {project.data.name}
              </h1>
              <p className="text-xs text-muted-foreground">{project.data.roleName}</p>
            </div>
            {project.data.health ? <Badge tone={HEALTH_TONE[project.data.health] ?? 'neutral'}>{healthLabel(project.data.health)}</Badge> : null}
          </div>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t('Overview')}</TabsTrigger>
              {can('tasks.all') || can('tasks.assigned') ? <TabsTrigger value="tasks">{can('tasks.all') ? t('Tasks') : t('My tasks')}</TabsTrigger> : null}
              {can('documents.view') ? <TabsTrigger value="documents">{t('Documents')}</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="overview" className="space-y-4">
              <OverviewCard project={project.data} />
            </TabsContent>
            <TabsContent value="tasks">
              <PortalTasks projectId={project.data.id} />
            </TabsContent>
            <TabsContent value="documents">
              <PortalDocuments projectId={project.data.id} canUpload={can('documents.upload')} />
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function OverviewCard({ project }: { project: PortalProjectView }) {
  return (
    <>
      {project.description || project.plannedStart || project.summary ? (
        <Card>
          <CardContent className="space-y-3 pt-4 text-sm">
            {project.description ? (
              <p className="whitespace-pre-wrap" dir="auto">
                {project.description}
              </p>
            ) : null}
            {project.plannedStart ? (
              <p className="text-xs text-muted-foreground">
                {t('Planned {from} to {to}', { from: formatShortDate(project.plannedStart), to: formatShortDate(project.plannedFinish) })}
              </p>
            ) : null}
            {project.summary ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  [t('Work items'), formatNumber(project.summary.total)],
                  [t('Done'), formatNumber(project.summary.closed)],
                  [t('Overdue'), formatNumber(project.summary.overdue)],
                  [t('Complete'), `${formatNumber(project.summary.percentDone)}%`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border p-3">
                    <div className="text-2xs text-muted-foreground">{label}</div>
                    <div className="text-lg font-semibold">{value}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {project.milestones ? (
        <Card>
          <CardHeader variant="compact">
            <CardTitle>{t('Milestones')}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <table className="w-full text-xs">
              <tbody>
                {project.milestones.map((milestone) => (
                  <tr key={milestone.id} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      {milestone.subject}
                    </td>
                    <td className="py-1.5">{milestone.date ? formatShortDate(milestone.date) : '—'}</td>
                    <td className="py-1.5 text-end">
                      <Badge tone={milestone.closed ? 'success' : 'neutral'}>{milestone.status}</Badge>
                    </td>
                  </tr>
                ))}
                {project.milestones.length === 0 ? (
                  <tr>
                    <td className="py-3 text-2xs text-muted-foreground">{t('No milestones.')}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function PortalTasks({ projectId }: { projectId: string }) {
  const tasks = useQuery({ queryKey: ['portal', 'tasks', projectId], queryFn: () => apiClient.get<PortalTaskRow[]>(`/portal/projects/${projectId}/tasks`) });
  return (
    <QueryBoundary isLoading={tasks.isLoading} isError={tasks.isError} error={tasks.error} onRetry={() => void tasks.refetch()} errorTitle={t('The tasks could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
      <Card>
        <CardContent className="overflow-x-auto pt-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Task')}</th>
                <th className="py-1.5 text-start font-medium">{t('Type')}</th>
                <th className="py-1.5 text-start font-medium">{t('Status')}</th>
                <th className="py-1.5 text-start font-medium">{t('Assignee')}</th>
                <th className="py-1.5 text-start font-medium">{t('Due')}</th>
              </tr>
            </thead>
            <tbody>
              {(tasks.data ?? []).map((task) => (
                <tr key={task.id} className="border-b border-border/60">
                  <td className="py-1.5" dir="auto">
                    <Link className="text-primary hover:underline" to={`/portal/tasks/${task.id}`}>
                      {task.subject}
                    </Link>
                  </td>
                  <td className="py-1.5">{task.type}</td>
                  <td className="py-1.5">{task.status}</td>
                  <td className="py-1.5" dir="auto">
                    {task.assignee ?? '—'}
                  </td>
                  <td className="py-1.5">{task.dueDate ? formatShortDate(task.dueDate) : '—'}</td>
                </tr>
              ))}
              {(tasks.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-2xs text-muted-foreground">
                    {t('No tasks.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </QueryBoundary>
  );
}

function PortalDocuments({ projectId, canUpload }: { projectId: string; canUpload: boolean }) {
  const client = useQueryClient();
  const documents = useQuery({ queryKey: ['portal', 'documents', projectId], queryFn: () => apiClient.get<PortalDocument[]>(`/portal/projects/${projectId}/documents`) });
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const response = await fetch(`${env.apiBaseUrl}/portal/projects/${projectId}/documents`, { method: 'POST', credentials: 'include', headers: { 'Accept-Language': intlLocale() }, body });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? response.statusText);
      toast.success(t('Document uploaded'));
      void client.invalidateQueries({ queryKey: ['portal', 'documents', projectId] });
    } catch (error) {
      toast.error(t('The document was not uploaded'), { description: errorText(error) });
    } finally {
      setUploading(false);
    }
  };
  const download = async (document: PortalDocument) => {
    try {
      saveBlob(await apiClient.download(`/portal/documents/${document.id}/content`), document.name);
    } catch (error) {
      toast.error(t('The download failed'), { description: errorText(error) });
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        {canUpload ? (
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
            <Upload className="h-4 w-4" />
            {uploading ? t('Uploading…') : t('Upload a document')}
            <input type="file" className="hidden" disabled={uploading} onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
          </label>
        ) : null}
        <QueryBoundary isLoading={documents.isLoading} isError={documents.isError} error={documents.error} onRetry={() => void documents.refetch()} errorTitle={t('The documents could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          <table className="w-full text-xs">
            <tbody>
              {(documents.data ?? []).map((document) => (
                <tr key={document.id} className="border-b border-border/60">
                  <td className="py-1.5" dir="auto">
                    <FileText className="me-1 inline h-3.5 w-3.5" />
                    {document.name}
                  </td>
                  <td className="py-1.5 text-muted-foreground" dir="auto">
                    {document.uploadedBy}
                  </td>
                  <td className="py-1.5">{formatShortDate(document.uploadedAt)}</td>
                  <td className="py-1.5 text-end">
                    <Button variant="ghost" size="sm" aria-label={t('Download')} onClick={() => void download(document)}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
              {(documents.data ?? []).length === 0 ? (
                <tr>
                  <td className="py-3 text-2xs text-muted-foreground">{t('No documents yet.')}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function PortalTaskPage() {
  const { id } = useParams<{ id: string }>();
  const client = useQueryClient();
  const task = useQuery({ queryKey: ['portal', 'task', id], queryFn: () => apiClient.get<PortalTaskView>(`/portal/tasks/${id}`) });
  const refresh = () => client.invalidateQueries({ queryKey: ['portal'] });
  const [comment, setComment] = useState('');
  const [hours, setHours] = useState('');
  const [day, setDay] = useState(toISODateOnly(new Date()));
  const addComment = useMutation({
    mutationFn: () => apiClient.post(`/portal/tasks/${id}/comments`, { text: comment }),
    onSuccess: () => {
      setComment('');
      void refresh();
    },
    onError: (error) => toast.error(t('The comment was not added'), { description: errorText(error) }),
  });
  const setStatus = useMutation({
    mutationFn: (statusId: string) => apiClient.patch(`/portal/tasks/${id}/status`, { statusId }),
    onSuccess: () => void refresh(),
    onError: (error) => toast.error(t('The status was not changed'), { description: errorText(error) }),
  });
  const logTime = useMutation({
    mutationFn: () => apiClient.post(`/portal/tasks/${id}/time`, { hours: Number(hours), spentOn: day }),
    onSuccess: () => {
      setHours('');
      toast.success(t('Time logged'));
    },
    onError: (error) => toast.error(t('The time was not logged'), { description: errorText(error) }),
  });
  return (
    <QueryBoundary isLoading={task.isLoading} isError={task.isError} error={task.error} onRetry={() => void task.refetch()} errorTitle={t('The task could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
      {task.data ? (
        <div className="space-y-4">
          <Link to={`/portal/projects/${task.data.projectId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground" dir="auto">
            <ArrowLeft className="h-3.5 w-3.5" />
            {task.data.projectName}
          </Link>
          <div>
            <h1 className="text-xl font-semibold" dir="auto">
              {task.data.subject}
            </h1>
            <p className="text-xs text-muted-foreground">
              {task.data.type} · {task.data.status} · {task.data.assignee ?? t('Unassigned')}
              {task.data.dueDate ? ` · ${t('Due {date}', { date: formatShortDate(task.data.dueDate) })}` : ''}
            </p>
          </div>
          {task.data.description ? (
            <Card>
              <CardContent className="whitespace-pre-wrap pt-4 text-sm" dir="auto">
                {task.data.description}
              </CardContent>
            </Card>
          ) : null}
          {task.data.can.changeStatus || task.data.can.logTime ? (
            <Card>
              <CardContent className="flex flex-wrap items-end gap-4 pt-4">
                {task.data.can.changeStatus ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="portal-status">{t('Status')}</Label>
                    <Select value={task.data.statuses.find((status) => status.name === task.data!.status)?.id} onValueChange={(value) => setStatus.mutate(value)}>
                      <SelectTrigger id="portal-status" className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {task.data.statuses.map((status) => (
                          <SelectItem key={status.id} value={status.id}>
                            {status.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {task.data.can.logTime ? (
                  <div className="flex items-end gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="portal-hours">{t('Hours')}</Label>
                      <Input id="portal-hours" className="w-24" inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="portal-day">{t('Date')}</Label>
                      <Input id="portal-day" type="date" className="w-40" value={day} onChange={(event) => setDay(event.target.value)} />
                    </div>
                    <Button size="sm" disabled={!(Number(hours) > 0)} loading={logTime.isPending} onClick={() => logTime.mutate()}>
                      {t('Log time')}
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader variant="compact">
              <CardTitle>{t('Comments')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              {task.data.comments.map((entry) => (
                <div key={entry.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="mb-1 text-2xs text-muted-foreground" dir="auto">
                    {entry.author} · {formatDateTime(entry.createdAt)}
                  </div>
                  <div className="whitespace-pre-wrap" dir="auto">
                    {entry.text}
                  </div>
                </div>
              ))}
              {task.data.comments.length === 0 ? <p className="text-2xs text-muted-foreground">{t('No comments yet.')}</p> : null}
              {task.data.can.comment ? (
                <div className="space-y-2">
                  <Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t('Write a comment')} />
                  <Button size="sm" disabled={!comment.trim()} loading={addComment.isPending} onClick={() => addComment.mutate()}>
                    {t('Comment')}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function PortalApprovalsPage() {
  const client = useQueryClient();
  const approvals = useQuery({ queryKey: ['portal', 'approvals'], queryFn: () => apiClient.get<PortalApproval[]>('/portal/approvals') });
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ taskId, decision }: { taskId: string; decision: 'approve' | 'reject' }) =>
      apiClient.post(`/portal/approvals/${taskId}/decide`, { decision, comment: comments[taskId] || undefined }),
    onSuccess: () => {
      toast.success(t('Decision recorded'));
      void client.invalidateQueries({ queryKey: ['portal'] });
    },
    onError: (error) => toast.error(t('The decision was not recorded'), { description: errorText(error) }),
  });
  return (
    <div className="space-y-4">
      <Link to="/portal" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('All projects')}
      </Link>
      <h1 className="text-xl font-semibold">{t('Approvals waiting for you')}</h1>
      <QueryBoundary isLoading={approvals.isLoading} isError={approvals.isError} error={approvals.error} onRetry={() => void approvals.refetch()} errorTitle={t('The approvals could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
        <div className="space-y-3">
          {(approvals.data ?? []).map((approval) => (
            <Card key={approval.taskId}>
              <CardContent className="space-y-2 pt-4 text-sm">
                <div className="font-medium" dir="auto">
                  {approval.title}
                </div>
                <div className="text-2xs text-muted-foreground" dir="auto">
                  {approval.projectName} · {approval.stepName} · {formatShortDate(approval.requestedAt)}
                </div>
                <Textarea value={comments[approval.taskId] ?? ''} onChange={(event) => setComments({ ...comments, [approval.taskId]: event.target.value })} placeholder={t('Comment (optional)')} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decide.mutate({ taskId: approval.taskId, decision: 'approve' })}>
                    {t('Approve')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide.mutate({ taskId: approval.taskId, decision: 'reject' })}>
                    {t('Reject')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {(approvals.data ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{t('Nothing is waiting for you.')}</p> : null}
        </div>
      </QueryBoundary>
    </div>
  );
}
