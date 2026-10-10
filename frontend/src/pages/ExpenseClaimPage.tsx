import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileText, Paperclip, Pencil, Send, Trash2, Undo2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { RequestCard } from '@/components/approvals/RequestCard';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ClaimDialog } from '@/components/expenses/ClaimDialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAddReceipt, useClaim, useClaimAction, useDeleteClaim, useRemoveReceipt } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { formatBytes, formatDateTime, formatNumber, formatShortDate } from '@/lib/utils';
import { CLAIM_STATUS } from '@/pages/ExpensesPage';
import { expenseService } from '@/services';
import type { ExpenseClaimView } from '@/types';

/**
 * One expense claim (BR-307 to BR-309): what it is for, its receipts, its
 * approval — decided here by whoever is asked — and, once approved, the
 * OpenProject cost entry it was posted as.
 */
export default function ExpenseClaimPage() {
  const { id } = useParams();
  const claim = useClaim(id);
  return (
    <div className="space-y-5">
      <QueryBoundary
        isLoading={claim.isLoading}
        isError={claim.isError}
        error={claim.error}
        onRetry={() => void claim.refetch()}
        errorTitle={t('The claim could not be loaded')}
        skeleton={<Skeleton className="h-64 w-full rounded-xl" />}
      >
        {claim.data ? <ClaimDetail claim={claim.data} /> : null}
      </QueryBoundary>
    </div>
  );
}

const failedWith = (title: string) => (error: unknown) => toast.error(title, { description: error instanceof Error ? error.message : undefined });

function ClaimDetail({ claim }: { claim: ExpenseClaimView }) {
  const navigate = useNavigate();
  const submit = useClaimAction('submit');
  const withdraw = useClaimAction('withdraw');
  const post = useClaimAction('post');
  const remove = useDeleteClaim();
  const addReceipt = useAddReceipt();
  const removeReceipt = useRemoveReceipt();
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const key = `EX-${claim.id.slice(-6).toUpperCase()}`;
  const status = claim.rejection ? { label: t('Rejected'), tone: 'danger' as const } : CLAIM_STATUS[claim.status];
  const missingReceipt = claim.receiptRequired && claim.receipts.length === 0;

  return (
    <>
      <PageHeader
        title={`${key} · ${claim.categoryName}`}
        description={`${formatNumber(claim.amount)} ${claim.currency} · ${formatShortDate(claim.spentOn)} · ${claim.claimantName}`}
        meta={<Badge tone={status.tone}>{status.label}</Badge>}
        actions={
          <>
            {claim.can.edit ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
                {t('Change')}
              </Button>
            ) : null}
            {claim.can.delete ? (
              <Button variant="secondary" onClick={() => setDeleting(true)}>
                <Trash2 className="h-4 w-4" />
                {t('Delete')}
              </Button>
            ) : null}
            {claim.can.withdraw ? (
              <Button
                variant="secondary"
                loading={withdraw.isPending}
                onClick={() => withdraw.mutate(claim.id, { onSuccess: () => toast.success(t('Claim withdrawn: it can be changed again')), onError: failedWith(t('The claim was not withdrawn')) })}
              >
                <Undo2 className="h-4 w-4" />
                {t('Withdraw')}
              </Button>
            ) : null}
            {claim.can.submit ? (
              <Button
                loading={submit.isPending}
                onClick={() => submit.mutate(claim.id, { onSuccess: () => toast.success(t('Claim submitted for approval')), onError: failedWith(t('The claim was not submitted')) })}
              >
                <Send className="h-4 w-4" />
                {t('Submit claim')}
              </Button>
            ) : null}
            {claim.can.post ? (
              <Button
                loading={post.isPending}
                onClick={() => post.mutate(claim.id, { onSuccess: () => toast.success(t('Posting tried again')), onError: failedWith(t('The claim was not posted')) })}
              >
                {t('Post to the project')}
              </Button>
            ) : null}
          </>
        }
      />

      {claim.rejection ? (
        <Alert tone="danger" title={t('Rejected by {name}', { name: claim.rejection.byName ?? t('Someone no longer listed') })}>
          <span dir="auto">{claim.rejection.reason}</span>
        </Alert>
      ) : null}
      {claim.postError ? (
        <Alert tone="warning" title={t('Approved, but not yet recorded against the project')}>
          {claim.postError}
        </Alert>
      ) : null}
      {missingReceipt && claim.status === 'draft' ? (
        <Alert tone="warning" title={t('A receipt is needed')}>
          {t('A claim of this amount needs a receipt before it can be submitted.')}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader variant="compact">
              <CardTitle>{t('The claim')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2 text-xs">
              <dl className="grid grid-cols-2 gap-3">
                <Row label={t('Project')} value={claim.projectName} />
                <Row
                  label={t('Work package')}
                  value={
                    <Link to={`/tasks/${claim.workPackageId}`} className="hover:text-primary" dir="auto">
                      {claim.workPackageSubject ?? `#${claim.workPackageId}`}
                    </Link>
                  }
                />
                <Row label={t('Category')} value={claim.categoryName} />
                <Row label={t('Amount')} value={`${formatNumber(claim.amount)} ${claim.currency}`} />
                <Row label={t('Paid on')} value={formatShortDate(claim.spentOn)} />
                <Row label={t('Claimant')} value={claim.claimantName} />
              </dl>
              <p className="whitespace-pre-wrap" dir="auto">
                {claim.description}
              </p>
              <p className="text-2xs text-muted-foreground">
                {claim.submittedAt ? t('Submitted {when}.', { when: formatDateTime(claim.submittedAt) }) : t('Not submitted.')}
                {claim.approvedAt ? ` ${t('Approved {when}.', { when: formatDateTime(claim.approvedAt) })}` : ''}
                {claim.postedAt && claim.costEntryId
                  ? ` ${t('Recorded against the project {when} as OpenProject cost entry {entry}.', { when: formatDateTime(claim.postedAt), entry: claim.costEntryId })}`
                  : ''}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              variant="compact"
              actions={
                claim.can.edit ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        addReceipt.mutate(
                          { id: claim.id, file },
                          { onSuccess: () => toast.success(t('Receipt added')), onError: failedWith(t('The receipt was not added')) },
                        );
                      }}
                    />
                    <Button size="sm" variant="secondary" loading={addReceipt.isPending} onClick={() => fileInput.current?.click()}>
                      <Upload className="h-3.5 w-3.5" />
                      {t('Add a receipt')}
                    </Button>
                  </>
                ) : null
              }
            >
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-muted-foreground" aria-hidden />
                {t('Receipts')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {claim.receipts.length === 0 ? (
                <p className="text-2xs text-muted-foreground">{t('No receipts attached.')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {claim.receipts.map((receipt) => (
                    <li key={receipt.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                      <a href={expenseService.receiptUrl(claim.id, receipt.id)} className="flex min-w-0 items-center gap-2 hover:text-primary">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate" dir="auto">
                          {receipt.fileName}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">{formatBytes(receipt.size)}</span>
                      </a>
                      {claim.can.edit ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('Remove this receipt')}
                          onClick={() =>
                            removeReceipt.mutate({ id: claim.id, receiptId: receipt.id }, { onError: failedWith(t('The receipt was not removed')) })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div>{claim.request ? <RequestCard request={claim.request} /> : null}</div>
      </div>

      <ClaimDialog open={editing} onOpenChange={setEditing} claim={claim} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('Delete this draft claim?')}
        description={t('It and its receipts are removed. This cannot be undone.')}
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(claim.id, {
            onSuccess: () => {
              toast.success(t('Claim deleted'));
              navigate('/expenses');
            },
            onError: failedWith(t('The claim was not deleted')),
          })
        }
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd dir="auto">{value}</dd>
    </div>
  );
}
