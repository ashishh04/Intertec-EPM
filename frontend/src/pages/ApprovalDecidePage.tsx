import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleSlash, ShieldCheck, XCircle } from 'lucide-react';

import { ApprovalSteps } from '@/components/approvals/ApprovalSteps';
import { REQUEST_STATUS } from '@/components/approvals/ApprovalPanel';
import { PageHeader } from '@/components/common/PageHeader';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApprovalLink, useDecideApprovalLink } from '@/hooks/useApprovals';
import { useUserMap } from '@/hooks/useUsers';
import { ApiError } from '@/services/api/client';
import type { ApprovalDecision } from '@/services/api/approvals';
import type { ApprovalRequestView } from '@/types';

/**
 * Where an approval email's links land (BR-215).
 *
 * Opening the link decides nothing: mail scanners open every link in a
 * message, and a decision made by one would be nobody's. The page shows what
 * is being decided and who it is for, and the person confirms. The link works
 * only for the person it was sent to, signed in, and only once.
 */
export default function ApprovalDecidePage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const link = useApprovalLink(token);
  const decide = useDecideApprovalLink();
  const users = useUserMap();

  const preset = params.get('decision');
  const [decision, setDecision] = useState<ApprovalDecision>(preset === 'reject' ? 'reject' : 'approve');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<ApprovalRequestView>();

  useEffect(() => {
    setDecision(preset === 'reject' ? 'reject' : 'approve');
  }, [preset]);

  if (link.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  if (link.isError) {
    const status = link.error instanceof ApiError ? link.error.status : 0;
    const message = link.error instanceof Error ? link.error.message : 'This link cannot be used.';
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader title="Approval link" />
        <Alert tone={status === 403 ? 'danger' : 'warning'} icon={status === 410 ? CircleSlash : XCircle} title={status === 410 ? 'This link is spent' : 'This link cannot be used'}>
          {message}
        </Alert>
        <Button asChild variant="secondary">
          <Link to="/approvals">Open Approvals</Link>
        </Button>
      </div>
    );
  }

  const view = link.data!;
  const request = result ?? view.request;
  const reject = decision === 'reject';
  const missing = reject && comment.trim().length < 3;

  if (result) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader title="Decision recorded" />
        <Alert tone="success" icon={CheckCircle2} title={reject ? 'Rejected' : 'Approved'}>
          {request.status === 'pending'
            ? 'Your step is done; the next approvers have been told.'
            : `The request is now ${REQUEST_STATUS[request.status].label.toLowerCase()}, and the requester has been told.`}
        </Alert>
        <div className="flex gap-2">
          <Button asChild>
            <Link to={`/tasks/${request.subjectId}`}>Open the work package</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/approvals">Back to Approvals</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        eyebrow="Approval"
        title={request.title}
        description={`${request.projectName ?? ''} · ${request.chainName}${
          request.value !== undefined ? ` · ${request.valueLabel ?? 'Value'} ${request.value.toLocaleString('en-US')}` : ''
        }`}
        meta={<Badge tone={REQUEST_STATUS[request.status].tone}>{REQUEST_STATUS[request.status].label}</Badge>}
      />

      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
            Your decision at “{view.stepName}”
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          {view.onBehalfOf ? (
            <Alert tone="neutral">You are deciding on behalf of {users.get(view.onBehalfOf)?.name ?? 'the approver'}, under their delegation.</Alert>
          ) : null}

          <div className="flex gap-2" role="radiogroup" aria-label="Decision">
            <Button variant={!reject ? 'default' : 'secondary'} role="radio" aria-checked={!reject} onClick={() => setDecision('approve')}>
              Approve
            </Button>
            <Button variant={reject ? 'danger' : 'secondary'} role="radio" aria-checked={reject} onClick={() => setDecision('reject')}>
              Reject
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="link-comment" required={reject}>
              {reject ? 'Reason' : 'Comment'}
            </Label>
            <Textarea
              id="link-comment"
              rows={3}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={reject ? 'What would have to change for this to be approved?' : 'Optional'}
              invalid={touched && missing}
            />
            {touched && missing ? (
              <FieldError>Say why you are rejecting it: the requester is shown your reason.</FieldError>
            ) : (
              <FieldHint>Nothing is decided until you confirm. This link then stops working.</FieldHint>
            )}
          </div>

          {decide.isError ? (
            <Alert tone="danger">{decide.error instanceof Error ? decide.error.message : 'That could not be recorded.'}</Alert>
          ) : null}

          <Button
            variant={reject ? 'danger' : 'default'}
            loading={decide.isPending}
            onClick={() => {
              setTouched(true);
              if (missing || !token) return;
              decide.mutate({ token, decision, comment: comment.trim() || undefined }, { onSuccess: setResult });
            }}
          >
            Confirm: {reject ? 'reject' : 'approve'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle>The chain so far</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {/* Read-only here: the decision above is the one this link makes. */}
          <ApprovalSteps steps={request.steps} />
        </CardContent>
      </Card>
    </div>
  );
}
