import { Check, Clock, CornerDownRight, Minus, X } from 'lucide-react';

import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { ApprovalDecision } from '@/services/api/approvals';
import type { ApprovalStepView, ApprovalTaskView } from '@/types';

/**
 * A request's steps, in order, with each approver's part in them.
 *
 * Shows what happened and what is left: who decided, on whose behalf, when and
 * why; who is still to decide and how long they have; and which steps did not
 * apply and why not. Where the viewer may decide, the buttons are on their own
 * row and nowhere else.
 */

const STEP_STATUS: Record<ApprovalStepView['status'], { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' }> = {
  waiting: { get label() { return t('Waiting'); }, tone: 'neutral' },
  active: { get label() { return t('Deciding now'); }, tone: 'primary' },
  approved: { get label() { return t('Approved'); }, tone: 'success' },
  rejected: { get label() { return t('Rejected'); }, tone: 'danger' },
  skipped: { get label() { return t('Skipped'); }, tone: 'neutral' },
};

function hoursText(ms: number): string {
  const hours = Math.abs(ms) / 3_600_000;
  if (hours < 1) return t('{minutes, number} min', { minutes: Math.max(1, Math.round(hours * 60)) });
  if (hours < 48) return t('{hours, number} h', { hours: Math.round(hours) });
  return t('{days, plural, one {# day} other {# days}}', { days: Math.round(hours / 24) });
}

function SlaNote({ task }: { task: ApprovalTaskView }) {
  if (task.status !== 'pending' || !task.dueAt) return null;
  const left = Date.parse(task.dueAt) - Date.now();
  if (task.breachedAt || left < 0) {
    return (
      <InfoTooltip label={t('SLA ran out {date}', { date: formatDateTime(task.dueAt) })}>
        <span tabIndex={0} className="inline-flex items-center gap-1 font-medium text-danger">
          <Clock className="h-3 w-3" aria-hidden />
          {t('Overdue by {duration}', { duration: hoursText(left) })}
          {task.breachedAt ? ` · ${t('escalated')}` : ''}
        </span>
      </InfoTooltip>
    );
  }
  return (
    <InfoTooltip label={t('Due {date}', { date: formatDateTime(task.dueAt) })}>
      <span tabIndex={0} className="inline-flex items-center gap-1 text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        {t('{duration} left', { duration: hoursText(left) })}
      </span>
    </InfoTooltip>
  );
}

interface ApprovalStepsProps {
  steps: ApprovalStepView[];
  /** Offered on a row the viewer may decide. Omit for a read-only view. */
  onDecide?: (task: ApprovalTaskView, decision: ApprovalDecision) => void;
  className?: string;
}

export function ApprovalSteps({ steps, onDecide, className }: ApprovalStepsProps) {
  const users = useUserMap();
  const name = (id?: string) => (id ? users.get(id)?.name ?? t('Someone no longer listed') : '');

  return (
    <ol className={cn('space-y-3', className)}>
      {steps.map((step) => {
        const meta = STEP_STATUS[step.status];
        return (
          <li
            key={step.index}
            className={cn(
              'rounded-lg border border-border p-3',
              step.status === 'active' && 'border-primary/40 bg-primary-soft/30',
              !step.applies && 'opacity-70',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold">
                <span className="me-1.5 font-mono text-2xs text-muted-foreground">{step.index + 1}</span>
                {step.name}
                <span className="ms-1.5 font-normal text-muted-foreground">
                  · {step.mode === 'all' ? t('everyone must approve') : t('any one approves')}
                  {step.slaHours ? ` · ${t('{hours, number} h SLA', { hours: step.slaHours })}` : ''}
                </span>
              </p>
              <Badge tone={meta.tone} className="text-2xs">
                {meta.label}
              </Badge>
            </div>
            {step.conditionText ? <p className="mt-1 text-2xs text-muted-foreground">{step.conditionText}</p> : null}

            {step.tasks.length > 0 ? (
              <ul className="mt-2.5 space-y-2.5">
                {step.tasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <UserAvatar user={users.get(task.approverId)} size="sm" />
                      <div className="min-w-0">
                        <p className="text-xs">
                          <span className="font-medium">{name(task.approverId)}</span>
                          {task.status === 'approved' ? (
                            <span className="ms-1.5 inline-flex items-center gap-0.5 text-success">
                              <Check className="h-3 w-3" aria-hidden /> {t('approved')}
                            </span>
                          ) : task.status === 'rejected' ? (
                            <span className="ms-1.5 inline-flex items-center gap-0.5 text-danger">
                              <X className="h-3 w-3" aria-hidden /> {t('rejected')}
                            </span>
                          ) : task.status === 'skipped' ? (
                            <span className="ms-1.5 inline-flex items-center gap-0.5 text-muted-foreground">
                              <Minus className="h-3 w-3" aria-hidden /> {t('not needed')}
                            </span>
                          ) : task.status === 'pending' ? (
                            <span className="ms-1.5 text-muted-foreground">{t('to decide')}</span>
                          ) : (
                            <span className="ms-1.5 text-muted-foreground">{t('waiting for the step before')}</span>
                          )}
                        </p>
                        {task.delegateId && task.status === 'pending' ? (
                          <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                            <CornerDownRight className="h-3 w-3" aria-hidden />
                            {t('Delegated to {name}; either may decide', { name: name(task.delegateId) })}
                          </p>
                        ) : null}
                        {task.decidedAt ? (
                          <p className="text-2xs text-muted-foreground">
                            {task.onBehalfOf ? `${t('By {name} on behalf of {principal}', { name: name(task.decidedBy), principal: name(task.onBehalfOf) })} · ` : ''}
                            <InfoTooltip label={formatDateTime(task.decidedAt)}>
                              <time tabIndex={0} dateTime={task.decidedAt}>
                                {formatRelative(task.decidedAt)}
                              </time>
                            </InfoTooltip>
                          </p>
                        ) : null}
                        {task.comment ? (
                          <p dir="auto" className="mt-1 border-s-2 border-border ps-2 text-xs italic text-muted-foreground">{task.comment}</p>
                        ) : null}
                        <p className="text-2xs">
                          <SlaNote task={task} />
                        </p>
                      </div>
                    </div>
                    {task.canDecide && onDecide ? (
                      <div className="flex shrink-0 gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => onDecide(task, 'reject')}>
                          {t('Reject')}
                        </Button>
                        <Button size="sm" onClick={() => onDecide(task, 'approve')}>
                          {t('Approve')}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
