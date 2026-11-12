import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ExternalLink, FolderPlus, Pencil, Send, Trash2, Undo2 } from 'lucide-react';

import { RequestCard } from '@/components/approvals/RequestCard';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ProjectRequestDialog } from '@/components/requests/ProjectRequestDialog';
import { REQUEST_STATUS } from '@/components/requests/requestMeta';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCopyJob } from '@/hooks/useProjectSettings';
import { useProjectRequest, useProjectRequestMutations } from '@/hooks/useRequests';
import { t } from '@/lib/i18n';
import { formatCurrency, formatDateTime, formatShortDate } from '@/lib/utils';

const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * One project request: what it proposes, where its approval stands, and — once
 * approved — turning it into the project, from its template if it names one.
 */
export default function ProjectRequestDetailPage() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const request = useProjectRequest(requestId);
  const mutations = useProjectRequestMutations();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const job = useCopyJob(jobId);
  const data = request.data;

  // A template copy, followed to the end: then the project is recorded on the request.
  useEffect(() => {
    if (!jobId || !job.data || !data) return;
    if (job.data.status === 'success' && job.data.projectId) {
      const projectId = job.data.projectId;
      setJobId(undefined);
      mutations.link.mutate(
        { id: data.id, projectId },
        {
          onSuccess: () => {
            toast.success(t('Project created from the request'));
            navigate(`/projects/${projectId}`);
          },
          onError: (error) => toast.error(t('The project was made, but not recorded on the request'), { description: errorText(error) }),
        },
      );
    } else if (['failure', 'error', 'cancelled'].includes(job.data.status)) {
      setJobId(undefined);
      toast.error(t('The copy did not finish.'), { description: job.data.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status, job.data?.projectId]);

  const createProject = () =>
    mutations.createProject.mutate(data!.id, {
      onSuccess: (result) => {
        if ('projectId' in result) {
          toast.success(t('Project created from the request'));
          navigate(`/projects/${result.projectId}`);
        } else {
          setJobId(result.jobId);
        }
      },
      onError: (error) => toast.error(t('The project could not be created'), { description: errorText(error) }),
    });

  const run = (action: 'submit' | 'withdraw', done: string) =>
    mutations[action].mutate(data!.id, {
      onSuccess: () => toast.success(done),
      onError: (error) => toast.error(t('That could not be changed'), { description: errorText(error) }),
    });

  const copying = Boolean(jobId) || mutations.createProject.isPending || mutations.link.isPending;

  return (
    <QueryBoundary
      isLoading={request.isLoading}
      isError={request.isError}
      error={request.error}
      onRetry={() => request.refetch()}
      errorTitle={t('Unable to load this request')}
      skeleton={<PageSkeleton />}
    >
      {data ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow={
              <Link to="/project-requests" className="inline-flex items-center gap-1 hover:underline">
                <ArrowLeft className="h-3 w-3 rtl:rotate-180" aria-hidden />
                {t('Project requests')}
              </Link>
            }
            title={data.title}
            meta={
              <>
                <Badge size="sm" className="font-mono">
                  {data.key}
                </Badge>
                <Badge size="sm" tone={REQUEST_STATUS[data.status].tone}>
                  {REQUEST_STATUS[data.status].label()}
                </Badge>
              </>
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {data.can.edit ? (
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('Edit')}
                  </Button>
                ) : null}
                {data.can.submit ? (
                  <Button size="sm" loading={mutations.submit.isPending} onClick={() => run('submit', t('Request submitted for approval'))}>
                    <Send className="h-3.5 w-3.5" />
                    {t('Submit for approval')}
                  </Button>
                ) : null}
                {data.can.withdraw ? (
                  <Button size="sm" variant="ghost" loading={mutations.withdraw.isPending} onClick={() => run('withdraw', t('Request withdrawn'))}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('Withdraw')}
                  </Button>
                ) : null}
                {data.can.createProject ? (
                  <Button size="sm" loading={copying} onClick={createProject}>
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t('Create the project')}
                  </Button>
                ) : null}
                {data.can.remove ? (
                  <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setDeleting(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('Delete')}
                  </Button>
                ) : null}
              </div>
            }
          />

          {copying && jobId ? <Alert tone="neutral">{t('Copying the template. This can take a minute for a large one.')}</Alert> : null}
          {data.status === 'created' && data.projectId ? (
            <Alert tone="success">
              <span className="me-2">{t('This request became a project.')}</span>
              <Link to={`/projects/${data.projectId}`} className="inline-flex items-center gap-1 font-medium underline">
                {t('Open the project')}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
            </Alert>
          ) : null}
          {data.status === 'approved' && !data.can.createProject ? (
            <Alert tone="neutral">{t('Approved. Someone who may create projects turns it into one.')}</Alert>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader variant="compact" className="border-b border-border">
                <CardTitle>{t('The proposal')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <Section label={t('What it is for')} text={data.description} />
                <Section label={t('Business case')} text={data.businessCase} />
                <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                  <Fact label={t('Sponsor')} value={data.sponsorName} />
                  <Fact label={t('Start from')} value={data.templateName ? t('Template: {name}', { name: data.templateName }) : t('A blank project')} />
                  <Fact label={t('Portfolio')} value={data.portfolioName} />
                  <Fact label={t('Program')} value={data.programName} />
                  <Fact label={t('Budget')} value={data.budget !== undefined ? formatCurrency(data.budget) : undefined} mono />
                  <Fact label={t('Identifier')} value={data.identifier} mono />
                  <Fact label={t('Planned start')} value={data.startDate ? formatShortDate(data.startDate) : undefined} />
                  <Fact label={t('Planned finish')} value={data.finishDate ? formatShortDate(data.finishDate) : undefined} />
                  <Fact label={t('Requested by')} value={data.requestedByName} />
                  <Fact label={t('Submitted')} value={data.submittedAt ? formatDateTime(data.submittedAt) : undefined} />
                </dl>
                {data.decidedAt ? (
                  <div className="rounded-md border border-border bg-surface-sunken/50 p-3 text-xs">
                    <p className="font-medium">
                      {t('{status, select, approved {Approved by {name}} rejected {Rejected by {name}} other {Decided by {name}}} on {date}', {
                        status: data.status === 'rejected' ? 'rejected' : 'approved',
                        name: data.decidedByName ?? t('Someone no longer listed'),
                        date: formatDateTime(data.decidedAt),
                      })}
                    </p>
                    {data.decisionNote ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground" dir="auto">{data.decisionNote}</p> : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
            <div className="space-y-4">
              {data.request ? (
                <RequestCard request={data.request} />
              ) : (
                <Card className="p-4 text-xs text-muted-foreground">{t('Not submitted yet. Submit it to send it for approval.')}</Card>
              )}
            </div>
          </div>

          <ProjectRequestDialog open={editing} onOpenChange={setEditing} request={data} />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={t('Delete {name}?', { name: data.title })}
            description={t('The request goes for good. A request waiting for approval is withdrawn first.')}
            confirmLabel={t('Delete permanently')}
            tone="danger"
            pending={mutations.remove.isPending}
            onConfirm={() =>
              mutations.remove.mutate(data.id, {
                onSuccess: () => {
                  toast.success(t('{name} deleted', { name: data.title }));
                  navigate('/project-requests', { replace: true });
                },
                onError: (error) => toast.error(t('That could not be deleted'), { description: errorText(error) }),
              })
            }
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function Section({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <div>
      <p className="epm-eyebrow">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm" dir="auto">
        {text}
      </p>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono tabular-nums' : ''} dir="auto">
        {value ?? '—'}
      </dd>
    </div>
  );
}
