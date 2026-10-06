import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useApprovalChains, useApprovalOptions, useDeleteApprovalChain, useSaveApprovalChain } from '@/hooks/useApprovals';
import { useUsers } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type {
  ApprovalApproverSpec,
  ApprovalChain,
  ApprovalChainInput,
  ApprovalChainOptions,
  ApprovalCondition,
  ApprovalConditionOperator,
  ApprovalStep,
} from '@/types';
import { describeError } from './shared-format';

/**
 * Approval chains (BR-211), as an administrator defines them.
 *
 * A chain covers work packages of the chosen types in every project or the
 * chosen ones, and lists its steps in order. Each step names who decides —
 * people, the project owner, everyone in a project role, the requester's
 * manager — whether all of them or any one must agree, an optional condition
 * under which it applies, an SLA and who hears when it is missed.
 *
 * Requests already in flight keep the chain as it was when they were
 * submitted; an edit changes what happens to the next one.
 */

const NONE = '__none__';

const blankStep = (index: number): ApprovalStep => ({
  id: `step-${Date.now().toString(36)}-${index}`,
  name: '',
  approvers: [{ kind: 'project_owner' }],
  mode: 'any',
});

const blankChain = (options?: ApprovalChainOptions): ApprovalChainInput => {
  const changeRequest = options?.types.find((type) => /change request/i.test(type.name));
  const status = (pattern: RegExp) => options?.statuses.find((candidate) => pattern.test(candidate.name))?.id;
  return {
    name: '',
    description: '',
    typeIds: changeRequest ? [changeRequest.id] : [],
    projectIds: [],
    valueField: options?.customFields.find((field) => field.numeric && /value/i.test(field.name))?.id,
    steps: [{ ...blankStep(0), name: 'Project owner' }],
    onSubmitStatusId: status(/^pending approval$/i),
    onApproveStatusId: status(/^approved$/i),
    onRejectStatusId: status(/^rejected$/i),
    allowSelfApproval: false,
    active: true,
  };
};

export default function ApprovalChainsPage() {
  const { can } = useAuth();
  const allowed = can('approvals:configure');
  const chains = useApprovalChains(allowed);
  const options = useApprovalOptions(allowed);
  const remove = useDeleteApprovalChain();
  const save = useSaveApprovalChain();
  const [editing, setEditing] = useState<{ id?: string; input: ApprovalChainInput }>();

  if (!allowed) {
    return (
      <Alert tone="neutral" title="Approval chains are configured by administrators">
        Changing who approves what needs the approvals configuration permission.
      </Alert>
    );
  }

  const describe = (chain: ApprovalChain) => {
    const types = chain.typeIds.length
      ? chain.typeIds.map((id) => options.data?.types.find((type) => type.id === id)?.name ?? id).join(', ')
      : 'every type';
    const projects = chain.projectIds.length ? `${chain.projectIds.length} ${chain.projectIds.length === 1 ? 'project' : 'projects'}` : 'every project';
    return `${types} · ${projects}`;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          variant="compact"
          actions={
            <Button size="sm" onClick={() => setEditing({ input: blankChain(options.data) })} disabled={!options.data}>
              <Plus className="h-3.5 w-3.5" />
              New chain
            </Button>
          }
        >
          <CardTitle>Approval chains</CardTitle>
          <CardDescription>
            Who must approve what, in which order. Covered work is submitted from its own page; every decision is
            journalled.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={chains.isLoading}
            isError={chains.isError}
            error={chains.error}
            onRetry={() => chains.refetch()}
            errorTitle="Unable to load approval chains"
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(chains.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={ShieldCheck}
                title="No approval chains yet"
                description="Create one to route change requests, or any other type of work, through approvers."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(chains.data ?? []).map((chain) => (
                <li key={chain.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {chain.name}
                      {chain.active ? <Badge tone="success" size="sm">Active</Badge> : <Badge tone="neutral" size="sm">Off</Badge>}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {describe(chain)} · {chain.steps.length} {chain.steps.length === 1 ? 'step' : 'steps'}: {chain.steps.map((step) => step.name).join(' → ')}
                      {chain.requestCount ? ` · used ${chain.requestCount} ${chain.requestCount === 1 ? 'time' : 'times'}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ id: chain.id, input: toInput(chain) })}>
                      Edit
                    </Button>
                    {chain.requestCount === 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${chain.name}`}
                        disabled={remove.isPending}
                        onClick={() =>
                          remove.mutate(chain.id, {
                            onSuccess: () => toast.success('Chain deleted'),
                            onError: (error) => toast.error('It could not be deleted', { description: describeError(error) }),
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </QueryBoundary>
        </CardContent>
      </Card>

      {editing && options.data ? (
        <ChainEditor
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          initial={editing.input}
          isNew={!editing.id}
          options={options.data}
          saving={save.isPending}
          onSave={(input) =>
            save.mutate(
              { id: editing.id, input },
              {
                onSuccess: () => {
                  toast.success(editing.id ? 'Chain saved' : 'Chain created', {
                    description: 'Requests already in flight keep the chain they were submitted under.',
                  });
                  setEditing(undefined);
                },
                onError: (error) => toast.error('The chain was not saved', { description: describeError(error) }),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function toInput(chain: ApprovalChain): ApprovalChainInput {
  return {
    name: chain.name,
    description: chain.description ?? '',
    typeIds: chain.typeIds,
    projectIds: chain.projectIds,
    valueField: chain.valueField,
    steps: chain.steps,
    onSubmitStatusId: chain.onSubmitStatusId,
    onApproveStatusId: chain.onApproveStatusId,
    onRejectStatusId: chain.onRejectStatusId,
    allowSelfApproval: chain.allowSelfApproval,
    active: chain.active,
  };
}

/* -------------------------------------------------------------------------- */

function ChainEditor({
  open,
  onOpenChange,
  initial,
  isNew,
  options,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ApprovalChainInput;
  isNew: boolean;
  options: ApprovalChainOptions;
  saving: boolean;
  onSave: (input: ApprovalChainInput) => void;
}) {
  const [draft, setDraft] = useState<ApprovalChainInput>(initial);

  const set = (patch: Partial<ApprovalChainInput>) => setDraft((was) => ({ ...was, ...patch }));
  const setStep = (index: number, patch: Partial<ApprovalStep>) =>
    setDraft((was) => ({ ...was, steps: was.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) }));
  const moveStep = (index: number, by: number) =>
    setDraft((was) => {
      const steps = [...was.steps];
      const [step] = steps.splice(index, 1);
      steps.splice(index + by, 0, step!);
      return { ...was, steps };
    });

  const problems = useMemo(() => {
    const found: string[] = [];
    if (!draft.name.trim()) found.push('Give the chain a name.');
    draft.steps.forEach((step, index) => {
      if (!step.name.trim()) found.push(`Step ${index + 1} needs a name.`);
      if (step.approvers.length === 0) found.push(`Step ${index + 1} needs at least one approver.`);
      if (step.condition?.field === 'value' && !draft.valueField) found.push(`Step ${index + 1} compares the value, so choose a value field.`);
      const condition = conditionProblem(step.condition);
      if (condition) found.push(`Step ${index + 1}: ${condition}.`);
      if (step.slaHours !== undefined && !(step.slaHours >= 0.25)) found.push(`Step ${index + 1}: an SLA is at least a quarter of an hour.`);
    });
    return found;
  }, [draft]);

  const statusSelect = (label: string, value: string | undefined, onChange: (value?: string) => void) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? undefined : next)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Leave unchanged</SelectItem>
          {options.statuses.map((status) => (
            <SelectItem key={status.id} value={status.id}>
              {status.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New approval chain' : 'Edit approval chain'}</DialogTitle>
          <DialogDescription>Steps run in order. Any rejection ends the request.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="chain-name" required>
                Name
              </Label>
              <Input id="chain-name" value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Change control" />
            </div>
            <div className="space-y-1.5">
              <Label>Value field</Label>
              <Select value={draft.valueField ?? NONE} onValueChange={(next) => set({ valueField: next === NONE ? undefined : next })}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No value</SelectItem>
                  {options.customFields
                    .filter((field) => field.numeric)
                    .map((field) => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <FieldHint>The figure value thresholds compare against.</FieldHint>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="chain-description">Description</Label>
            <Textarea id="chain-description" rows={2} maxLength={1000} value={draft.description ?? ''} onChange={(event) => set({ description: event.target.value })} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Work package types</Label>
              <MultiSelect
                label="Work package types"
                options={options.types}
                selected={options.types.filter((type) => draft.typeIds.includes(type.id))}
                onChange={(selected) => set({ typeIds: selected.map((type) => type.id) })}
                placeholder="Every type"
              />
            </div>
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
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {statusSelect('When submitted', draft.onSubmitStatusId, (value) => set({ onSubmitStatusId: value }))}
            {statusSelect('When approved', draft.onApproveStatusId, (value) => set({ onApproveStatusId: value }))}
            {statusSelect('When rejected', draft.onRejectStatusId, (value) => set({ onRejectStatusId: value }))}
          </div>
          <FieldHint>
            These statuses can then only be reached through the chain: nobody can set them by hand on a covered work
            package.
          </FieldHint>

          <div className="space-y-3">
            <p className="text-xs font-semibold">Steps</p>
            {draft.steps.map((step, index) => (
              <StepEditor
                key={step.id}
                index={index}
                count={draft.steps.length}
                step={step}
                options={options}
                hasValueField={Boolean(draft.valueField)}
                onChange={(patch) => setStep(index, patch)}
                onMove={(by) => moveStep(index, by)}
                onRemove={() => setDraft((was) => ({ ...was, steps: was.steps.filter((_, i) => i !== index) }))}
              />
            ))}
            {draft.steps.length < 10 ? (
              <Button size="sm" variant="secondary" onClick={() => setDraft((was) => ({ ...was, steps: [...was.steps, blankStep(was.steps.length)] }))}>
                <Plus className="h-3.5 w-3.5" />
                Add a step
              </Button>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={draft.active} onCheckedChange={(active) => set({ active })} aria-label="Active" />
              Active
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={draft.allowSelfApproval} onCheckedChange={(allowSelfApproval) => set({ allowSelfApproval })} aria-label="Allow self-approval" />
              Whoever submits may also approve
            </label>
          </div>

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
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button loading={saving} disabled={problems.length > 0} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            {isNew ? 'Create chain' : 'Save chain'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

function StepEditor({
  index,
  count,
  step,
  options,
  hasValueField,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  step: ApprovalStep;
  options: ApprovalChainOptions;
  hasValueField: boolean;
  onChange: (patch: Partial<ApprovalStep>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs text-muted-foreground">{index + 1}</span>
        <Input
          aria-label={`Step ${index + 1} name`}
          value={step.name}
          maxLength={80}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="e.g. Sponsor sign-off"
          className="h-8 text-xs"
        />
        <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Remove step" disabled={count === 1} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Approvers</Label>
          <ApproverPicker value={step.approvers} options={options} onChange={(approvers) => onChange({ approvers })} />
        </div>
        <div className="space-y-1.5">
          <Label>Decided by</Label>
          <Select value={step.mode} onValueChange={(mode) => onChange({ mode: mode as ApprovalStep['mode'] })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any one of them</SelectItem>
              <SelectItem value="all">All of them</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ConditionEditor value={step.condition} options={options} hasValueField={hasValueField} onChange={(condition) => onChange({ condition })} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`sla-${step.id}`}>SLA (hours)</Label>
          <Input
            id={`sla-${step.id}`}
            type="number"
            min={0.25}
            step={0.25}
            value={step.slaHours ?? ''}
            placeholder="None"
            onChange={(event) => onChange({ slaHours: event.target.value === '' ? undefined : Number(event.target.value) })}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>When the SLA is missed, tell</Label>
          <ApproverPicker
            value={step.escalateTo ?? []}
            options={options}
            onChange={(escalateTo) => onChange({ escalateTo: escalateTo.length ? escalateTo : undefined })}
            emptyText="The project owner"
          />
        </div>
      </div>
    </div>
  );
}

function ApproverPicker({
  value,
  options,
  onChange,
  emptyText = 'Nobody yet',
}: {
  value: ApprovalApproverSpec[];
  options: ApprovalChainOptions;
  onChange: (value: ApprovalApproverSpec[]) => void;
  emptyText?: string;
}) {
  const users = useUsers();
  const [adding, setAdding] = useState<string>();

  const label = (spec: ApprovalApproverSpec) => {
    if (spec.kind === 'user') return users.data?.find((user) => user.id === spec.userId)?.name ?? `Person ${spec.userId}`;
    if (spec.kind === 'project_owner') return 'Project owner';
    if (spec.kind === 'requester_manager') return "Requester's manager";
    return `Role: ${options.roles.find((role) => role.id === spec.roleId)?.name ?? spec.roleId}`;
  };
  const key = (spec: ApprovalApproverSpec) =>
    spec.kind === 'user' ? `user:${spec.userId}` : spec.kind === 'project_role' ? `role:${spec.roleId}` : spec.kind;

  const choices = [
    { id: 'project_owner', name: 'Project owner' },
    { id: 'requester_manager', name: "Requester's manager" },
    ...options.roles.map((role) => ({ id: `role:${role.id}`, name: `Everyone in role: ${role.name}` })),
    ...(users.data ?? []).map((user) => ({ id: `user:${user.id}`, name: user.name })),
  ].filter((choice) => !value.some((spec) => key(spec) === choice.id));

  const add = (id?: string) => {
    if (!id) return;
    const spec: ApprovalApproverSpec =
      id === 'project_owner'
        ? { kind: 'project_owner' }
        : id === 'requester_manager'
          ? { kind: 'requester_manager' }
          : id.startsWith('role:')
            ? { kind: 'project_role', roleId: id.slice(5) }
            : { kind: 'user', userId: id.slice(5) };
    onChange([...value, spec]);
    setAdding(undefined);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? <span className="text-2xs text-muted-foreground">{emptyText}</span> : null}
        {value.map((spec) => (
          <Badge key={key(spec)} tone="neutral" size="sm" className="gap-1">
            {label(spec)}
            <button type="button" aria-label={`Remove ${label(spec)}`} onClick={() => onChange(value.filter((one) => key(one) !== key(spec)))}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <ComboSelect label="Add an approver" options={choices} value={adding} onChange={add} placeholder="Add…" />
    </div>
  );
}

type ConditionField = 'always' | 'value' | 'type' | 'priority' | 'project' | 'portfolio' | 'custom';

const FIELD_CHOICES: { id: ConditionField; label: string }[] = [
  { id: 'always', label: 'Always' },
  { id: 'value', label: 'When the value' },
  { id: 'type', label: 'When the type' },
  { id: 'priority', label: 'When the priority' },
  { id: 'project', label: 'When the project' },
  { id: 'portfolio', label: 'When the portfolio' },
  { id: 'custom', label: 'When a custom field' },
];

const OPERATOR_WORDS: Record<ApprovalConditionOperator, string> = {
  gt: 'is above',
  gte: 'is at least',
  lt: 'is below',
  lte: 'is at most',
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
};

const isList = (operator: ApprovalConditionOperator) => operator === 'in' || operator === 'not_in';
const isComparison = (operator: ApprovalConditionOperator) =>
  operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte';
const comparesIds = (kind: ConditionField) => kind === 'type' || kind === 'priority' || kind === 'project' || kind === 'portfolio';

function fieldKind(condition?: ApprovalCondition): ConditionField {
  if (!condition) return 'always';
  if (condition.field.startsWith('customField')) return 'custom';
  return condition.field as ConditionField;
}

/** The operators that make sense for a field. Ids only match or don't, so they get membership alone. */
function operatorsFor(kind: ConditionField, numeric: boolean): ApprovalConditionOperator[] {
  if (kind === 'value') return ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
  if (kind === 'custom') return numeric ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'] : ['eq', 'neq', 'in', 'not_in'];
  return ['in', 'not_in'];
}

/** Keeps what was entered when the operator changes, in the shape the new operator takes. */
function reshape(value: ApprovalCondition['value'], operator: ApprovalConditionOperator, kind: ConditionField): ApprovalCondition['value'] {
  const first = Array.isArray(value) ? value[0] ?? '' : value;
  if (isList(operator)) return Array.isArray(value) ? value : first === '' ? [] : [String(first)];
  if (isComparison(operator) || kind === 'value') {
    const number = typeof first === 'number' ? first : first.trim() === '' ? Number.NaN : Number(first);
    return Number.isFinite(number) ? number : '';
  }
  return String(first);
}

/** What stops a condition being saved, if anything. */
function conditionProblem(condition?: ApprovalCondition): string | undefined {
  if (!condition) return undefined;
  if (isList(condition.operator)) {
    return Array.isArray(condition.value) && condition.value.length > 0 ? undefined : 'choose at least one value for its condition';
  }
  if (isComparison(condition.operator) || condition.field === 'value') {
    return typeof condition.value === 'number' && Number.isFinite(condition.value) ? undefined : 'give its condition a number';
  }
  return String(condition.value).trim() ? undefined : 'say what its condition compares with';
}

function ConditionEditor({
  value,
  options,
  hasValueField,
  onChange,
}: {
  value?: ApprovalCondition;
  options: ApprovalChainOptions;
  hasValueField: boolean;
  onChange: (value?: ApprovalCondition) => void;
}) {
  const kind = fieldKind(value);
  const customField = kind === 'custom' ? options.customFields.find((field) => field.id === value?.field) : undefined;
  // An id is or isn't among those chosen, so "is" and "is not" read as one-of and none-of.
  const operator: ApprovalConditionOperator | undefined =
    value && comparesIds(kind) ? (value.operator === 'eq' ? 'in' : value.operator === 'neq' ? 'not_in' : value.operator) : value?.operator;
  const offered = kind === 'always' ? [] : operatorsFor(kind, customField?.numeric ?? false);
  if (operator && !offered.includes(operator)) offered.push(operator);

  const listFor = (field: ConditionField) =>
    field === 'type' ? options.types : field === 'priority' ? options.priorities : field === 'project' ? options.projects : options.portfolios;
  const chosenIds = !value ? [] : Array.isArray(value.value) ? value.value : String(value.value) ? [String(value.value)] : [];

  const fields = FIELD_CHOICES.filter(
    (choice) =>
      choice.id === kind ||
      (choice.id === 'value' ? hasValueField : choice.id === 'custom' ? options.customFields.length > 0 : true),
  );

  const changeField = (next: string) => {
    if (next === 'always') return onChange(undefined);
    if (next === 'value') return onChange({ field: 'value', operator: 'gte', value: '' });
    if (next === 'custom') return onChange({ field: options.customFields[0]!.id, operator: 'eq', value: '' });
    return onChange({ field: next, operator: 'in', value: [] });
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-44 space-y-1.5">
        <Label>Applies</Label>
        <Select value={kind} onValueChange={changeField}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fields.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {kind === 'custom' && value ? (
        <div className="w-44 space-y-1.5">
          <Label>Field</Label>
          <Select
            value={value.field}
            onValueChange={(field) => {
              const numeric = options.customFields.find((one) => one.id === field)?.numeric ?? false;
              const next = operatorsFor('custom', numeric).includes(value.operator) ? value.operator : 'eq';
              onChange({ field, operator: next, value: reshape(value.value, next, 'custom') });
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.customFields.map((field) => (
                <SelectItem key={field.id} value={field.id}>
                  {field.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {value && operator ? (
        <>
          <div className="w-32 space-y-1.5">
            <Label className="sr-only">Comparison</Label>
            <Select
              value={operator}
              onValueChange={(next) => {
                const chosen = next as ApprovalConditionOperator;
                onChange({ ...value, operator: chosen, value: comparesIds(kind) ? chosenIds : reshape(value.value, chosen, kind) });
              }}
            >
              <SelectTrigger className="h-8 text-xs" aria-label="Comparison">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {offered.map((one) => (
                  <SelectItem key={one} value={one}>
                    {OPERATOR_WORDS[one]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-48 flex-1">
            {comparesIds(kind) ? (
              <MultiSelect
                label="Values"
                options={listFor(kind)}
                selected={listFor(kind).filter((item) => chosenIds.includes(item.id))}
                onChange={(selected) => onChange({ ...value, operator, value: selected.map((item) => item.id) })}
                placeholder="Choose…"
              />
            ) : isList(operator) ? (
              <ListTextInput value={chosenIds} onChange={(list) => onChange({ ...value, value: list })} />
            ) : isComparison(operator) || kind === 'value' ? (
              <Input
                type="number"
                aria-label="Compared with"
                value={typeof value.value === 'number' ? value.value : ''}
                onChange={(event) => onChange({ ...value, value: event.target.value === '' ? '' : Number(event.target.value) })}
                className="h-8 text-xs"
              />
            ) : (
              <Input
                aria-label="Compared with"
                value={String(value.value)}
                maxLength={200}
                onChange={(event) => onChange({ ...value, value: event.target.value })}
                className="h-8 text-xs"
              />
            )}
          </div>
        </>
      ) : (
        <FieldHint className="pb-2">This step runs for every request.</FieldHint>
      )}
    </div>
  );
}

/** A comma-separated list, kept as typed so a trailing comma survives until the next entry. */
function ListTextInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      aria-label="Compared with"
      value={text}
      placeholder="Comma-separated"
      onChange={(event) => {
        setText(event.target.value);
        onChange(
          event.target.value
            .split(',')
            .map((one) => one.trim())
            .filter(Boolean),
        );
      }}
      className="h-8 text-xs"
    />
  );
}
