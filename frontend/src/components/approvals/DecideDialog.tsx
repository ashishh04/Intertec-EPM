import { useEffect, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import type { ApprovalDecision } from '@/services/api/approvals';

/**
 * Confirms an approval decision, with a comment.
 *
 * Rejecting needs a reason — the requester is shown it and has to act on it.
 * Approving takes an optional one. Both are written to the journal with the
 * decision, and neither can be changed afterwards.
 */
interface DecideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decision: ApprovalDecision;
  /** What is being decided, e.g. "CHANGE-12 Extend the reporting scope". */
  subject: string;
  stepName: string;
  /** Set when the person decides as a delegate. */
  onBehalfOfName?: string;
  pending: boolean;
  error?: string;
  onConfirm: (comment?: string) => void;
}

export function DecideDialog({
  open,
  onOpenChange,
  decision,
  subject,
  stepName,
  onBehalfOfName,
  pending,
  error,
  onConfirm,
}: DecideDialogProps) {
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setComment('');
    setTouched(false);
  }, [open, decision]);

  const reject = decision === 'reject';
  const missing = reject && comment.trim().length < 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{reject ? 'Reject' : 'Approve'}</DialogTitle>
          <DialogDescription>
            {subject} · {stepName}
            {onBehalfOfName ? ` · on behalf of ${onBehalfOfName}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="decision-comment" required={reject}>
            {reject ? 'Reason' : 'Comment'}
          </Label>
          <Textarea
            id="decision-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={reject ? 'What would have to change for this to be approved?' : 'Optional'}
            invalid={touched && missing}
          />
          {touched && missing ? (
            <FieldError>Say why you are rejecting it: the requester is shown your reason.</FieldError>
          ) : (
            <FieldHint>Recorded in the journal with your decision. It cannot be changed afterwards.</FieldHint>
          )}
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={reject ? 'danger' : 'default'}
            loading={pending}
            onClick={() => {
              setTouched(true);
              if (missing) return;
              onConfirm(comment.trim() || undefined);
            }}
          >
            {reject ? 'Reject' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
