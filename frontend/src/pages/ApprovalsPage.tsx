import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Inbox, Send, ShieldCheck, UserRoundCheck } from 'lucide-react';
import { toast } from 'sonner';

import { ApprovalSteps } from '@/components/approvals/ApprovalSteps';
import { DecideDialog } from '@/components/approvals/DecideDialog';
import { REQUEST_STATUS } from '@/components/approvals/ApprovalPanel';
import { ComboSelect } from '@/components/common/ComboSelect';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useApprovalDelegations,
  useApprovalInbox,
  useApprovalRequests,
  useCreateDelegation,
  useDecideApproval,
  useRevokeDelegation,
} from '@/hooks/useApprovals';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { cn, formatDateTime, formatLongDate, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { ApprovalDecision } from '@/services/api/approvals';
import type { ApprovalRequestView, ApprovalTaskView } from '@/types';

/**
 * Approvals (BRQ-09): what is waiting on me, what I asked for, what is going
 * on in my projects, and who decides for me while I am away.
 */
export default function ApprovalsPage() {
  const inbox = useApprovalInbox();
  const [tab, setTab] = useState('inbox');
  const waiting = inbox.data?.length ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Approvals')}
        description={t('Change requests and other work that needs a decision, and who decides what while someone is away.')}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="underline">
          <TabsTrigger value="inbox" variant="underline">
            {t('Waiting for me')}{waiting > 0 ? ` (${waiting})` : ''}
          </TabsTrigger>
          <TabsTrigger value="mine" variant="underline">
            {t('Submitted by me')}
          </TabsTrigger>
          <TabsTrigger value="projects" variant="underline">
            {t('In my projects')}
          </TabsTrigger>
          <TabsTrigger value="delegations" variant="underline">
            {t('Delegation')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inbox" className="mt-4">
          <RequestList
            query={inbox}
            expanded
            empty={{ icon: Inbox, title: t('Nothing is waiting for you'), description: t('Approvals you are asked for, or hold as a delegate, appear here.') }}
          />
        </TabsContent>
        <TabsContent value="mine" className="mt-4">
          <MineTab />
        </TabsContent>
        <TabsContent value="projects" className="mt-4">
          <ProjectsTab />
        </TabsContent>
        <TabsContent value="delegations" className="mt-4">
          <DelegationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MineTab() {
  const mine = useApprovalRequests('mine');
  return (
    <RequestList
      query={mine}
      empty={{ icon: Send, title: t('You have not submitted anything'), description: t('Submit a change request for approval from its own page.') }}
    />
  );
}

function ProjectsTab() {
  const [status, setStatus] = useState<string>('pending');
  const requests = useApprovalRequests('projects', status === 'all' ? undefined : status);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {(['pending', 'approved', 'rejected', 'cancelled', 'all'] as const).map((value) => (
          <Button key={value} size="sm" variant={status === value ? 'subtle' : 'ghost'} onClick={() => setStatus(value)}>
            {value === 'all' ? t('All') : REQUEST_STATUS[value].label}
          </Button>
        ))}
      </div>
      <RequestList
        query={requests}
        empty={{ icon: ShieldCheck, title: t('No requests here'), description: t('Approval requests in the projects you can see appear here.') }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface ListQuery {
  data?: ApprovalRequestView[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

function RequestList({
  query,
  expanded = false,
  empty,
}: {
  query: ListQuery;
  expanded?: boolean;
  empty: { icon: typeof Inbox; title: string; description: string };
}) {
  const decide = useDecideApproval();
  const users = useUserMap();
  const { user: viewer } = useAuth();
  const [deciding, setDeciding] = useState<{ request: ApprovalRequestView; task: ApprovalTaskView; decision: ApprovalDecision }>();
  const [error, setError] = useState<string>();

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => query.refetch()}
      errorTitle={t('Unable to load approvals')}
      skeleton={<ListSkeleton rows={3} />}
      isEmpty={(query.data ?? []).length === 0}
      empty={
        <Card>
          <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
        </Card>
      }
    >
      <div className="space-y-3">
        {(query.data ?? []).map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            defaultExpanded={expanded}
            onDecide={(task, decision) => {
              setError(undefined);
              setDeciding({ request, task, decision });
            }}
          />
        ))}
      </div>

      {deciding ? (
        <DecideDialog
          open
          onOpenChange={(open) => !open && setDeciding(undefined)}
          decision={deciding.decision}
          subject={deciding.request.title}
          stepName={deciding.request.steps.find((step) => step.tasks.some((task) => task.id === deciding.task.id))?.name ?? ''}
          onBehalfOfName={
            viewer && deciding.task.approverId !== viewer.id ? users.get(deciding.task.approverId)?.name : undefined
          }
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
                onError: (failure) => setError(failure instanceof Error ? failure.message : t('That could not be recorded.')),
              },
            )
          }
        />
      ) : null}
    </QueryBoundary>
  );
}

function RequestCard({
  request,
  defaultExpanded,
  onDecide,
}: {
  request: ApprovalRequestView;
  defaultExpanded: boolean;
  onDecide: (task: ApprovalTaskView, decision: ApprovalDecision) => void;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  const users = useUserMap();
  const status = REQUEST_STATUS[request.status];
  const step = request.steps[request.currentStep];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Link to={request.link ?? `/tasks/${request.subjectId}`} dir="auto" className="text-sm font-semibold hover:text-primary">
              {request.title}
            </Link>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {[
                request.projectName,
                request.chainName,
                request.value !== undefined ? `${request.valueLabel ?? t('Value')} ${request.value.toLocaleString('en-US')}` : undefined,
                t('submitted by {name} {when}', {
                  name: users.get(request.requestedBy)?.name ?? t('someone'),
                  when: formatRelative(request.requestedAt),
                }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {request.status === 'pending' && step ? (
              <p className="mt-0.5 text-2xs">
                {t('Step {current, number} of {total, number}:', {
                  current: request.currentStep + 1,
                  total: request.steps.filter((one) => one.applies).length,
                })}{' '}
                <span className="font-medium">{step.name}</span>
              </p>
            ) : request.completedAt ? (
              <p className="mt-0.5 text-2xs text-muted-foreground">{t('Closed {date}', { date: formatDateTime(request.completedAt) })}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <Button size="icon-sm" variant="ghost" aria-label={open ? t('Hide the steps') : t('Show the steps')} onClick={() => setOpen((was) => !was)}>
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {request.outcomeError ? <Alert tone="warning">{request.outcomeError}</Alert> : null}
        {open ? <ApprovalSteps steps={request.steps} onDecide={onDecide} /> : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Delegation (BR-212)                                                         */
/* -------------------------------------------------------------------------- */

function DelegationsTab() {
  const { user: viewer, can } = useAuth();
  const mayConfigure = can('approvals:configure');
  const [all, setAll] = useState(false);
  const delegations = useApprovalDelegations(all && mayConfigure);
  const revoke = useRevokeDelegation();
  const users = useUserMap();
  const [creating, setCreating] = useState(false);
  const name = (id: string) => users.get(id)?.name ?? t('Someone no longer listed');

  return (
    <div className="space-y-3">
      <Alert tone="neutral" icon={UserRoundCheck}>
        {t('Handing your approvals to a colleague lets them decide for you during the dates you choose. You keep the right to decide too, and every decision they make is recorded as made on your behalf.')}
      </Alert>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {mayConfigure ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant={!all ? 'subtle' : 'ghost'} onClick={() => setAll(false)}>
              {t('Mine')}
            </Button>
            <Button size="sm" variant={all ? 'subtle' : 'ghost'} onClick={() => setAll(true)}>
              {t('Everyone\'s')}
            </Button>
          </div>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={() => setCreating(true)}>
          {t('Delegate my approvals')}
        </Button>
      </div>

      <QueryBoundary
        isLoading={delegations.isLoading}
        isError={delegations.isError}
        error={delegations.error}
        onRetry={() => delegations.refetch()}
        errorTitle={t('Unable to load delegations')}
        skeleton={<ListSkeleton rows={2} />}
        isEmpty={(delegations.data ?? []).length === 0}
        empty={
          <Card>
            <EmptyState icon={UserRoundCheck} title={t('No delegations')} description={t('Nobody decides for you, and you decide for nobody.')} />
          </Card>
        }
      >
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {(delegations.data ?? []).map((delegation) => (
              <div key={delegation.id} className={cn('flex flex-wrap items-center justify-between gap-2 px-4 py-3', delegation.revokedAt && 'opacity-60')}>
                <div className="min-w-0 text-xs">
                  <p>
                    <span className="font-medium">{name(delegation.delegatorId)}</span> {t('→')}{' '}
                    <span className="font-medium">{name(delegation.delegateId)}</span>
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    {t('{start} to {end}', { start: formatLongDate(delegation.startsOn), end: formatLongDate(delegation.endsOn) })}
                    {delegation.reason ? ` · ${delegation.reason}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {delegation.revokedAt ? (
                    <Badge tone="neutral" className="text-2xs">{t('Revoked')}</Badge>
                  ) : delegation.active ? (
                    <Badge tone="success" className="text-2xs">{t('In force')}</Badge>
                  ) : (
                    <Badge tone="neutral" className="text-2xs">{delegation.endsOn < new Date().toISOString().slice(0, 10) ? t('Ended') : t('Scheduled')}</Badge>
                  )}
                  {!delegation.revokedAt && (delegation.delegatorId === viewer?.id || mayConfigure) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={revoke.isPending}
                      onClick={() =>
                        revoke.mutate(delegation.id, {
                          onSuccess: () => toast.success(t('Delegation revoked')),
                          onError: (error) => toast.error(t('It could not be revoked'), { description: error instanceof Error ? error.message : undefined }),
                        })
                      }
                    >
                      {t('Revoke')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </QueryBoundary>

      <DelegationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function DelegationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const users = useUsers();
  const { user: viewer } = useAuth();
  const create = useCreateDelegation();
  const today = new Date().toISOString().slice(0, 10);
  const [delegateId, setDelegateId] = useState<string>();
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(today);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setDelegateId(undefined);
    setStartsOn(today);
    setEndsOn(today);
    setReason('');
    setError(undefined);
  }, [open, today]);

  const options = (users.data ?? [])
    .filter((user) => user.id !== viewer?.id)
    .map((user) => ({ id: user.id, name: user.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Delegate my approvals')}</DialogTitle>
          <DialogDescription>
            {t('While this is in force, your delegate can decide anything waiting on you, and is told about new approvals too.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="delegate" required>
              {t('Delegate to')}
            </Label>
            <ComboSelect id="delegate" label={t('Delegate to')} options={options} value={delegateId} onChange={setDelegateId} placeholder={t('Choose a colleague')} loading={users.isLoading} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="delegation-from">{t('From')}</Label>
              <Input id="delegation-from" type="date" value={startsOn} min={today} onChange={(event) => setStartsOn(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delegation-to">{t('To')}</Label>
              <Input id="delegation-to" type="date" value={endsOn} min={startsOn} onChange={(event) => setEndsOn(event.target.value)} />
            </div>
          </div>
          <FieldHint>{t('Both days included. Revoke it at any time to take your approvals back early.')}</FieldHint>
          <div className="space-y-1.5">
            <Label htmlFor="delegation-reason">{t('Reason')}</Label>
            <Textarea id="delegation-reason" rows={2} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder={t('e.g. Annual leave')} />
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('Cancel')}
          </Button>
          <Button
            loading={create.isPending}
            disabled={!delegateId || endsOn < startsOn}
            onClick={() =>
              create.mutate(
                { delegateId: delegateId!, startsOn, endsOn, reason: reason.trim() || undefined },
                {
                  onSuccess: () => {
                    toast.success(t('Approvals delegated'));
                    onOpenChange(false);
                  },
                  onError: (failure) => setError(failure instanceof Error ? failure.message : t('That could not be saved.')),
                },
              )
            }
          >
            {t('Delegate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
