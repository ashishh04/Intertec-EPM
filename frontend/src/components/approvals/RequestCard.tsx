import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { REQUEST_STATUS } from '@/components/approvals/ApprovalPanel';
import { ApprovalSteps } from '@/components/approvals/ApprovalSteps';
import { DecideDialog } from '@/components/approvals/DecideDialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDecideApproval } from '@/hooks/useApprovals';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';
import type { ApprovalDecision } from '@/services/api/approvals';
import type { ApprovalRequestView, ApprovalTaskView } from '@/types';

/**
 * An approval request of a timesheet or an expense claim, on its own page: who
 * is asked at each step and what they decided, with the decision offered to
 * whoever may take it now (Module 10, reusing the engine of BR-211 to BR-215).
 */
export function RequestCard({ request }: { request: ApprovalRequestView }) {
  const decide = useDecideApproval();
  const users = useUserMap();
  const { user: viewer } = useAuth();
  const [deciding, setDeciding] = useState<{ task: ApprovalTaskView; decision: ApprovalDecision; stepName: string }>();
  const [error, setError] = useState<string>();
  const name = (id?: string) => (id ? users.get(id)?.name ?? t('Someone no longer listed') : '');

  return (
    <Card>
      <CardHeader
        className="border-b border-border"
        actions={<Badge tone={REQUEST_STATUS[request.status].tone}>{REQUEST_STATUS[request.status].label}</Badge>}
      >
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Approval')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <p className="text-xs text-muted-foreground">
          {request.chainName}
          {` · ${t('submitted by')} `}
          <span className="text-foreground">{name(request.requestedBy)}</span>{' '}
          <time dateTime={request.requestedAt} title={formatDateTime(request.requestedAt)}>
            {formatRelative(request.requestedAt)}
          </time>
        </p>
        {request.outcomeError ? (
          <Alert tone="warning" title={t('The decision stands, but applying it did not complete')}>
            {request.outcomeError}
          </Alert>
        ) : null}
        <ApprovalSteps
          steps={request.steps}
          onDecide={(task, decision) => {
            setError(undefined);
            setDeciding({ task, decision, stepName: request.steps.find((step) => step.tasks.some((one) => one.id === task.id))?.name ?? '' });
          }}
        />
      </CardContent>
      {deciding ? (
        <DecideDialog
          open
          onOpenChange={(open) => !open && setDeciding(undefined)}
          decision={deciding.decision}
          subject={request.title}
          stepName={deciding.stepName}
          onBehalfOfName={deciding.task.delegateId && deciding.task.delegateId === viewer?.id ? name(deciding.task.approverId) : undefined}
          pending={decide.isPending}
          error={error}
          onConfirm={(comment) =>
            decide.mutate(
              { taskId: deciding.task.id, decision: deciding.decision, comment },
              {
                onSuccess: () => {
                  toast.success(deciding.decision === 'approve' ? t('Approved') : t('Rejected'));
                  setDeciding(undefined);
                },
                onError: (failure) => setError(failure instanceof Error ? failure.message : t('The decision was not recorded.')),
              },
            )
          }
        />
      ) : null}
    </Card>
  );
}
