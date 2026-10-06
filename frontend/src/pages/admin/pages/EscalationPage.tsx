import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, Plus, Siren, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { AutomationStatusCard } from '@/components/automation/AutomationStatusCard';
import { PersonPicker } from '@/components/automation/PersonPicker';
import { PERSON_WORDS, TRIGGER_WORDS } from '@/components/automation/vocabulary';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAutomationOptions,
  useDeleteEscalationPolicy,
  useDryRunPolicy,
  useEscalationPolicies,
  useEscalations,
  useSaveEscalationPolicy,
} from '@/hooks/useAutomation';
import { useUserMap } from '@/hooks/useUsers';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type {
  AutomationOptions,
  EscalationLevel,
  EscalationPolicy,
  EscalationPolicyInput,
  EscalationTrigger,
  ID,
  PersonSpec,
} from '@/types';
import { describeError } from './shared-format';

/**
 * Escalation policies (BR-218), and what they have raised.
 *
 * A policy names a condition — untouched, overdue, or an approval past its
 * SLA — and a path: after this long tell these people, after longer tell the
 * next. The sweep raises each item one level at a time and resolves it when
 * the item is touched, closed, rescheduled or decided.
 */

const PEOPLE: Record<EscalationTrigger, PersonSpec['kind'][]> = {
  untouched: ['assignee', 'responsible', 'author', 'team_lead', 'department_manager', 'project_owner', 'project_role', 'user'],
  overdue: ['assignee', 'responsible', 'author', 'team_lead', 'department_manager', 'project_owner', 'project_role', 'user'],
  approval_sla: ['approvers', 'team_lead', 'department_manager', 'project_owner', 'project_role', 'user'],
};

const blankPolicy = (): EscalationPolicyInput => ({
  name: '',
  description: '',
  active: true,
  trigger: 'untouched',
  projectIds: [],
  typeIds: [],
  priorityIds: [],
  levels: [
    { after: 3, notify: [{ kind: 'assignee' }] },
    { after: 5, notify: [{ kind: 'team_lead' }] },
    { after: 8, notify: [{ kind: 'department_manager' }] },
  ],
});

const toInput = (policy: EscalationPolicy): EscalationPolicyInput => ({
  name: policy.name,
  description: policy.description ?? '',
  active: policy.active,
  trigger: policy.trigger,
  projectIds: policy.projectIds,
  typeIds: policy.typeIds,
  priorityIds: policy.priorityIds,
  levels: policy.levels,
});

function describeLevels(policy: EscalationPolicyInput): string {
  const unit = TRIGGER_WORDS[policy.trigger].unit;
  return policy.levels
    .map((level) => `${level.after} ${unit} → ${level.notify.map((person) => PERSON_WORDS[person.kind].toLowerCase()).join(', ')}`)
    .join('; ');
}

export default function EscalationPage() {
  const { can } = useAuth();
  const allowed = can('rules:configure');
  const policies = useEscalationPolicies(allowed);
  const options = useAutomationOptions(allowed);
  const save = useSaveEscalationPolicy();
  const remove = useDeleteEscalationPolicy();
  const [editing, setEditing] = useState<{ id?: ID; input: EscalationPolicyInput }>();

  if (!allowed) {
    return (
      <Alert tone="neutral" title="Escalation is configured by administrators">
        Deciding who is chased about what needs the rules configuration permission.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <AutomationStatusCard show="escalation" />

      <Card>
        <CardHeader
          variant="compact"
          actions={
            <Button size="sm" onClick={() => setEditing({ input: blankPolicy() })} disabled={!options.data}>
              <Plus className="h-3.5 w-3.5" />
              New policy
            </Button>
          }
        >
          <CardTitle>Escalation policies</CardTitle>
          <CardDescription>Who is told, level by level, when work stalls or an approval waits too long.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={policies.isLoading}
            isError={policies.isError}
            error={policies.error}
            onRetry={() => policies.refetch()}
            errorTitle="Unable to load the policies"
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(policies.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={Siren}
                title="No escalation policies yet"
                description="A policy chases untouched or overdue work, and approvals past their SLA, up a path you define."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(policies.data ?? []).map((policy) => (
                <li key={policy.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {policy.name}
                      <Badge tone={policy.active ? 'success' : 'neutral'} size="sm">
                        {policy.active ? 'On' : 'Off'}
                      </Badge>
                      {policy.openCount > 0 ? (
                        <Badge tone="warning" size="sm">
                          {policy.openCount} open
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {TRIGGER_WORDS[policy.trigger].label} · {describeLevels(policy)}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ id: policy.id, input: toInput(policy) })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${policy.name}`}
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate(policy.id, {
                          onSuccess: () => toast.success('Policy deleted'),
                          onError: (error) => toast.error('It could not be deleted', { description: describeError(error) }),
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </QueryBoundary>
        </CardContent>
      </Card>

      <EscalationsCard />

      {editing && options.data ? (
        <PolicyEditor
          id={editing.id}
          initial={editing.input}
          options={options.data}
          saving={save.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(input) =>
            save.mutate(
              { id: editing.id, input },
              {
                onSuccess: () => {
                  toast.success(editing.id ? 'Policy saved' : 'Policy created');
                  setEditing(undefined);
                },
                onError: (error) => toast.error('The policy was not saved', { description: describeError(error) }),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function problemsOf(policy: EscalationPolicyInput): string[] {
  const found: string[] = [];
  const approvals = policy.trigger === 'approval_sla';
  if (!policy.name.trim()) found.push('Give the policy a name.');
  if (policy.levels.length === 0) found.push('Add at least one level.');
  policy.levels.forEach((level, index) => {
    if (level.notify.length === 0) found.push(`Level ${index + 1}: say who is told.`);
    const valid = approvals ? level.after >= 0 : Number.isInteger(level.after) && level.after >= 1;
    if (!valid) found.push(`Level ${index + 1}: ${approvals ? 'hours, from 0' : 'whole days, from 1'}.`);
    const previous = policy.levels[index - 1];
    if (previous && level.after <= previous.after) found.push(`Level ${index + 1} has to come later than level ${index}.`);
  });
  return found;
}

function PolicyEditor({
  id,
  initial,
  options,
  saving,
  onClose,
  onSave,
}: {
  id?: ID;
  initial: EscalationPolicyInput;
  options: AutomationOptions;
  saving: boolean;
  onClose: () => void;
  onSave: (input: EscalationPolicyInput) => void;
}) {
  const [draft, setDraft] = useState<EscalationPolicyInput>(initial);
  const set = (patch: Partial<EscalationPolicyInput>) => setDraft((was) => ({ ...was, ...patch }));
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const trigger = TRIGGER_WORDS[draft.trigger];
  const dryRun = useDryRunPolicy();
  const names = useUserMap();

  const setLevel = (index: number, patch: Partial<EscalationLevel>) =>
    set({ levels: draft.levels.map((level, i) => (i === index ? { ...level, ...patch } : level)) });

  const changeTrigger = (next: EscalationTrigger) =>
    set({
      trigger: next,
      typeIds: next === 'approval_sla' ? [] : draft.typeIds,
      priorityIds: next === 'approval_sla' ? [] : draft.priorityIds,
      levels: draft.levels.map((level) => ({
        ...level,
        notify: level.notify.filter((person) => PEOPLE[next].includes(person.kind)),
      })),
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{id ? 'Edit escalation policy' : 'New escalation policy'}</DialogTitle>
          <DialogDescription>An item is raised one level at a time, and resolved when it is dealt with.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-name" required>
                Name
              </Label>
              <Input id="policy-name" value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Stalled delivery work" />
            </div>
            <div className="space-y-1.5">
              <Label>Escalates</Label>
              <Select value={draft.trigger} onValueChange={(value) => changeTrigger(value as EscalationTrigger)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TRIGGER_WORDS) as EscalationTrigger[]).map((one) => (
                    <SelectItem key={one} value={one}>
                      {TRIGGER_WORDS[one].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>{trigger.explain}</FieldHint>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-description">Description</Label>
            <Textarea id="policy-description" rows={2} maxLength={1000} value={draft.description ?? ''} onChange={(event) => set({ description: event.target.value })} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Projects</Label>
              <MultiSelect
                label="Projects"
                options={options.projects}
                selected={options.projects.filter((project) => draft.projectIds.includes(project.id))}
                onChange={(selected) => set({ projectIds: selected.map((project) => project.id) })}
                placeholder="Every project"
              />
            </div>
            {draft.trigger !== 'approval_sla' ? (
              <>
                <div className="space-y-1.5">
                  <Label>Types</Label>
                  <MultiSelect
                    label="Types"
                    options={options.types}
                    selected={options.types.filter((type) => draft.typeIds.includes(type.id))}
                    onChange={(selected) => set({ typeIds: selected.map((type) => type.id) })}
                    placeholder="Every type"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Priorities</Label>
                  <MultiSelect
                    label="Priorities"
                    options={options.priorities}
                    selected={options.priorities.filter((priority) => draft.priorityIds.includes(priority.id))}
                    onChange={(selected) => set({ priorityIds: selected.map((priority) => priority.id) })}
                    placeholder="Every priority"
                  />
                </div>
              </>
            ) : null}
          </div>

          <section className="space-y-2">
            <p className="text-xs font-semibold">Path</p>
            {draft.levels.map((level, index) => (
              <div key={index} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[9rem_1fr_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor={`level-${index}`}>Level {index + 1} after</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`level-${index}`}
                      type="number"
                      min={draft.trigger === 'approval_sla' ? 0 : 1}
                      step={draft.trigger === 'approval_sla' ? 0.5 : 1}
                      value={level.after}
                      onChange={(event) => setLevel(index, { after: Number(event.target.value) })}
                      className="h-8 w-20 text-xs"
                    />
                    <span className="text-xs text-muted-foreground">{trigger.unit}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Tell</Label>
                  <PersonPicker
                    kinds={PEOPLE[draft.trigger]}
                    options={options}
                    value={level.notify}
                    onChange={(notify) => setLevel(index, { notify })}
                    emptyText="Nobody yet — the project owner is told when nobody named is set"
                  />
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove level ${index + 1}`}
                  disabled={draft.levels.length === 1}
                  onClick={() => set({ levels: draft.levels.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {draft.levels.length < 5 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  set({
                    levels: [
                      ...draft.levels,
                      { after: (draft.levels.at(-1)?.after ?? 0) + (draft.trigger === 'approval_sla' ? 8 : 2), notify: [{ kind: 'project_owner' }] },
                    ],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                Add a level
              </Button>
            ) : null}
          </section>

          <section className="space-y-2 rounded-lg border border-dashed border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                loading={dryRun.isPending}
                disabled={problems.length > 0}
                onClick={() => dryRun.mutate({ ...draft, id })}
              >
                <FlaskConical className="h-3.5 w-3.5" />
                What would escalate now
              </Button>
              <FieldHint>Raises nothing and tells nobody.</FieldHint>
            </div>
            {dryRun.isError ? <Alert tone="danger">{describeError(dryRun.error)}</Alert> : null}
            {dryRun.data ? (
              dryRun.data.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing would escalate now ({dryRun.data.evaluated} {dryRun.data.evaluated === 1 ? 'item' : 'items'} checked).
                </p>
              ) : (
                <ul className="max-h-56 space-y-1.5 overflow-y-auto">
                  {dryRun.data.items.map((item) => (
                    <li key={`${item.subjectType}-${item.subjectId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                      <span className="min-w-0">
                        <span className="font-medium">{item.title}</span>
                        {item.projectName ? <span className="text-muted-foreground"> · {item.projectName}</span> : null}
                        <span className="block text-2xs text-muted-foreground">
                          Since {formatDateTime(item.since)} · would tell {item.recipients.map((one) => names.get(one)?.name ?? 'someone').join(', ') || 'nobody'}
                        </span>
                      </span>
                      <Badge tone={item.alreadyRaised ? 'neutral' : 'warning'} size="sm">
                        Level {item.level}
                        {item.alreadyRaised ? ', already raised' : ''}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>

          <label className="flex items-center gap-2 text-xs">
            <Switch checked={draft.active} onCheckedChange={(active) => set({ active })} aria-label="Active" />
            On
          </label>

          {problems.length > 0 ? (
            <Alert tone="warning" title="Before it can be saved">
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button loading={saving} disabled={problems.length > 0} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            {id ? 'Save policy' : 'Create policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EscalationsCard() {
  const [state, setState] = useState<'open' | 'resolved' | 'all'>('open');
  const escalations = useEscalations(true, state);
  const names = useUserMap();

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>Escalations</CardTitle>
        <CardDescription>What has been raised, by policies and by approval steps past their SLA.</CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <Tabs value={state} onValueChange={(value) => setState(value as typeof state)}>
          <TabsList>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="resolved">Resolved</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
          <TabsContent value={state} className="mt-3">
            <QueryBoundary
              isLoading={escalations.isLoading}
              isError={escalations.isError}
              error={escalations.error}
              onRetry={() => escalations.refetch()}
              errorTitle="Unable to load escalations"
              skeleton={<ListSkeleton rows={3} />}
              isEmpty={(escalations.data ?? []).length === 0}
              empty={<EmptyState size="inline" icon={Siren} title={state === 'open' ? 'Nothing is escalated' : 'Nothing here yet'} />}
            >
              <ul className="divide-y divide-border">
                {(escalations.data ?? []).map((escalation) => (
                  <li key={escalation.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">
                        {escalation.link ? (
                          <Link to={escalation.link} className="hover:underline">
                            {escalation.subjectTitle ?? escalation.subjectId}
                          </Link>
                        ) : (
                          escalation.subjectTitle ?? escalation.subjectId
                        )}
                        {escalation.projectName ? <span className="font-normal text-muted-foreground"> · {escalation.projectName}</span> : null}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {escalation.policyName ?? (escalation.source === 'approval.sla' ? 'Approval SLA' : escalation.source)} · told{' '}
                        {escalation.raisedFor.map((one) => names.get(one)?.name ?? 'someone').join(', ') || 'nobody'}
                      </p>
                      <p className="text-2xs text-muted-foreground">{escalation.reason}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge tone={escalation.resolvedAt ? 'neutral' : escalation.level >= 2 ? 'danger' : 'warning'} size="sm">
                        Level {escalation.level}
                      </Badge>
                      <span className="text-2xs text-muted-foreground" title={formatDateTime(escalation.raisedAt)}>
                        {escalation.resolvedAt ? `Resolved ${formatRelative(escalation.resolvedAt)}` : `Raised ${formatRelative(escalation.raisedAt)}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </QueryBoundary>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
