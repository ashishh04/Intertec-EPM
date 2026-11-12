import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Undo2 } from 'lucide-react';

import { RequestCard } from '@/components/approvals/RequestCard';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { GATE_STATUS } from '@/components/requests/requestMeta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useStageGateMutations, useStageGateReview } from '@/hooks/useRequests';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';

/** One gate review: the project and gate, the case made for passing it, and its approval. */
export default function StageGateReviewPage() {
  const { reviewId } = useParams();
  const review = useStageGateReview(reviewId);
  const { withdraw } = useStageGateMutations();
  const data = review.data;

  return (
    <QueryBoundary
      isLoading={review.isLoading}
      isError={review.isError}
      error={review.error}
      onRetry={() => review.refetch()}
      errorTitle={t('Unable to load this gate review')}
      skeleton={<PageSkeleton />}
    >
      {data ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow={
              <Link to={`/projects/${data.projectId}/settings`} className="inline-flex items-center gap-1 hover:underline">
                <ArrowLeft className="h-3 w-3 rtl:rotate-180" aria-hidden />
                {data.projectName ?? t('Project')}
              </Link>
            }
            title={data.gateName}
            description={data.gate === 'start' ? t('Opens {phase}', { phase: data.phaseName }) : t('Closes {phase}', { phase: data.phaseName })}
            meta={
              <>
                <Badge size="sm" className="font-mono">
                  {data.key}
                </Badge>
                <Badge size="sm" tone={GATE_STATUS[data.status].tone}>
                  {GATE_STATUS[data.status].label()}
                </Badge>
              </>
            }
            actions={
              data.canWithdraw ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={withdraw.isPending}
                  onClick={() =>
                    withdraw.mutate(data.id, {
                      onSuccess: () => toast.success(t('Gate review withdrawn')),
                      onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }),
                    })
                  }
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {t('Withdraw')}
                </Button>
              ) : null
            }
          />
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader variant="compact" className="border-b border-border">
                <CardTitle>{t('The case for passing it')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-4 text-sm">
                <p className="whitespace-pre-wrap" dir="auto">
                  {data.notes ?? t('No case was written.')}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {t('Asked by {name} on {date}', { name: data.requestedByName ?? t('Someone no longer listed'), date: formatDateTime(data.createdAt) })}
                </p>
                {data.decidedAt ? (
                  <div className="rounded-md border border-border bg-surface-sunken/50 p-3 text-xs">
                    <p className="font-medium">
                      {t('{status, select, approved {Passed: approved by {name}} rejected {Not passed: rejected by {name}} other {Withdrawn by {name}}} on {date}', {
                        status: data.status,
                        name: data.decidedByName ?? t('Someone no longer listed'),
                        date: formatDateTime(data.decidedAt),
                      })}
                    </p>
                    {data.decisionNote ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground" dir="auto">{data.decisionNote}</p> : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
            <div>{data.request ? <RequestCard request={data.request} /> : null}</div>
          </div>
        </div>
      ) : null}
    </QueryBoundary>
  );
}
