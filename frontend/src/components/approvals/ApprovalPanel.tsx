import { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { ApprovalSteps } from '@/components/approvals/ApprovalSteps';
import { DecideDialog } from '@/components/approvals/DecideDialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useApprovalJournal,
  useApprovalSubject,
  useCancelApproval,
  useDecideApproval,
  useSubmitForApproval,
} from '@/hooks/useApprovals';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { ApprovalDecision } from '@/services/api/approvals';
import type { ApprovalRequestView, ApprovalTaskView, ID } from '@/types';

/**
 * A work package's approval (BRQ-09), on its own page.
 *
 * Before submission it shows the chain that applies and which of its steps
 * will run for this work package's values; after, the request step by step,
 * with the decide buttons for whoever may decide, and the full journal of the
 * request on demand. Renders nothing for a work package no chain governs.
 */

export const REQUEST_STATUS: Record<ApprovalRequestView['status'], { label: string; tone: 'primary' | 'success' | 'danger' | 'neutral' }> = {
  pending: { get label() { return t('Waiting for approval'); }, tone: 'primary' },
  approved: { get label() { return t('Approved'); }, tone: 'success' },
  rejected: { get label() { return t('Rejected'); }, tone: 'danger' },
  cancelled: { get label() { return t('Withdrawn'); }, tone: 'neutral' },
};

export function ApprovalPanel({ workPackageId }: { workPackageId: ID }) {
  const subject = useApprovalSubject(workPackageId);
  const submit = useSubmitForApproval();
  const decide = useDecideApproval();
  const cancel = useCancelApproval();
  const users = useUserMap();
  const { user: viewer } = useAuth();

  const [deciding, setDeciding] = useState<{ task: ApprovalTaskView; decision: ApprovalDecision; stepName: string }>();
  const [decideError, setDecideError] = useState<string>();
  const [withdrawing, setWithdrawing] = useState(false);
  const [showRecord, setShowRecord] = useState(false);

  const state = subject.data;
  const current = state?.current;
  const journal = useApprovalJournal(showRecord ? current?.id : undefined);

  if (subject.isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;
  // No chain and no history: approvals do not concern this work package.
  if (!state || (!state.chain && !current)) return null;

  const name = (id?: string) => (id ? users.get(id)?.name ?? t('Someone no longer listed') : '');
  const pending = current?.status === 'pending';

  return (
    <Card>
      <CardHeader
        className="border-b border-border"
        actions={
          current ? (
            <Badge tone={REQUEST_STATUS[current.status].tone}>{REQUEST_STATUS[current.status].label}</Badge>
          ) : null
        }
      >
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Approval')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {current ? (
          <>
            <p className="text-xs text-muted-foreground">
              {current.chainName}
              {current.value !== undefined ? ` · ${current.valueLabel ?? t('Value')} ${current.value.toLocaleString('en-US')}` : ''}
              {` · ${t('submitted by')} `}
              <span className="text-foreground">{name(current.requestedBy)}</span>{' '}
              <time dateTime={current.requestedAt} title={formatDateTime(current.requestedAt)}>
                {formatRelative(current.requestedAt)}
              </time>
            </p>

            {current.outcomeError ? (
              <Alert tone="warning" title={t('The decision stands, but the status could not be moved')}>
                {current.outcomeError}
              </Alert>
            ) : null}

            <ApprovalSteps
              steps={current.steps}
              onDecide={(task, decision) => {
                setDecideError(undefined);
                setDeciding({ task, decision, stepName: current.steps.find((step) => step.tasks.some((one) => one.id === task.id))?.name ?? '' });
              }}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowRecord((was) => !was)}>
                {showRecord ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {showRecord ? t('Hide the record') : t('Show the record')}
              </Button>
              {current.can.cancel ? (
                <Button size="sm" variant="secondary" onClick={() => setWithdrawing(true)}>
                  {t('Withdraw request')}
                </Button>
              ) : null}
            </div>

            {showRecord ? (
              <ol className="space-y-2 border-t border-border pt-3">
                {(journal.data ?? []).map((entry) => (
                  <li key={entry.id} className="text-xs">
                    <p>{entry.summary}</p>
                    {entry.reason ? <p dir="auto" className="mt-0.5 border-s-2 border-border ps-2 italic text-muted-foreground">{entry.reason}</p> : null}
                    <p className="text-2xs text-muted-foreground">
                      {entry.actorKind === 'system' ? 'EPM' : entry.actorKind === 'service' ? t('EPM Automation') : name(entry.actorId)} · {formatDateTime(entry.occurredAt)}
                    </p>
                  </li>
                ))}
                {journal.isLoading ? <Skeleton className="h-10 w-full" /> : null}
              </ol>
            ) : null}
          </>
        ) : null}

        {/* What would happen: shown when nothing is in flight. */}
        {state.chain && !pending ? (
          <div className={cn('space-y-2', current && 'border-t border-border pt-4')}>
            <p className="text-xs">
              {current ? t('Submitting again goes through') : t('Changes of this kind go through')} <span className="font-medium">{state.chain.name}</span>:
            </p>
            <ol className="space-y-1">
              {state.chain.steps.map((step, index) => (
                <li key={`${step.name}-${index}`} className={cn('text-xs', !step.applies && 'text-muted-foreground')}>
                  <span className="me-1.5 font-mono text-2xs text-muted-foreground">{index + 1}</span>
                  {/* Struck through alone: the reason it is skipped has to stay readable. */}
                  <span className={cn(!step.applies && 'line-through')}>{step.name}</span>
                  {step.conditionText ? <span className="ms-1.5 text-2xs text-muted-foreground">— {step.conditionText}</span> : null}
                </li>
              ))}
            </ol>
            {state.canSubmit ? (
              <Button
                size="sm"
                loading={submit.isPending}
                onClick={() =>
                  submit.mutate(workPackageId, {
                    onSuccess: () => toast.success(t('Submitted for approval'), { description: t('The first approvers have been told.') }),
                    onError: (error) =>
                      toast.error(t('It could not be submitted'), { description: error instanceof Error ? error.message : undefined }),
                  })
                }
              >
                {t('Submit for approval')}
              </Button>
            ) : state.submitBlocked ? (
              <p className="text-2xs text-muted-foreground">{state.submitBlocked}</p>
            ) : null}
          </div>
        ) : null}

        {state.history.length > 0 ? (
          <div className="border-t border-border pt-3">
            <p className="epm-eyebrow">{t('Earlier requests')}</p>
            <ul className="mt-1.5 space-y-1">
              {state.history.map((request) => (
                <li key={request.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {formatDateTime(request.requestedAt)} · {name(request.requestedBy)}
                  </span>
                  <Badge tone={REQUEST_STATUS[request.status].tone} className="text-2xs">
                    {REQUEST_STATUS[request.status].label}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      {deciding && current ? (
        <DecideDialog
          open
          onOpenChange={(open) => !open && setDeciding(undefined)}
          decision={deciding.decision}
          subject={current.title}
          stepName={deciding.stepName}
          onBehalfOfName={viewer && deciding.task.approverId !== viewer.id ? name(deciding.task.approverId) : undefined}
          pending={decide.isPending}
          error={decideError}
          onConfirm={(comment) =>
            decide.mutate(
              { taskId: deciding.task.id, decision: deciding.decision, comment },
              {
                onSuccess: (request) => {
                  setDeciding(undefined);
                  toast.success(deciding.decision === 'approve' ? t('Approved') : t('Rejected'), {
                    description:
                      request.status === 'pending'
                        ? t('The next step has been started.')
                        : t(
                            '{status, select, approved {The request is approved.} rejected {The request is rejected.} cancelled {The request is withdrawn.} other {The request is waiting for approval.}}',
                            { status: request.status },
                          ),
                  });
                },
                onError: (error) => setDecideError(error instanceof Error ? error.message : t('That could not be recorded.')),
              },
            )
          }
        />
      ) : null}

      {current ? (
        <ConfirmDialog
          open={withdrawing}
          onOpenChange={setWithdrawing}
          title={t('Withdraw this request?')}
          description={t('Nobody else will be asked to decide it, and the work package goes back to the status it had before it was submitted. It can be submitted again.')}
          confirmLabel={t('Withdraw')}
          pending={cancel.isPending}
          onConfirm={() =>
            cancel.mutate(
              { requestId: current.id },
              {
                onSuccess: () => {
                  setWithdrawing(false);
                  toast.success(t('Request withdrawn'));
                },
                onError: (error) =>
                  toast.error(t('It could not be withdrawn'), { description: error instanceof Error ? error.message : undefined }),
              },
            )
          }
        />
      ) : null}
    </Card>
  );
}
