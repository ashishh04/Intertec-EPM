import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, CheckCircle2, CircleSlash, FlaskConical, ListChecks, Plus, Trash2, Workflow, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { AutomationStatusCard } from '@/components/automation/AutomationStatusCard';
import { PersonPicker } from '@/components/automation/PersonPicker';
import {
  ACTION_WORDS,
  ACTIONS_BY_SUBJECT,
  DAY_COUNT,
  EVENT_WORDS,
  EVENTS_BY_SUBJECT,
  HEALTH_WORDS,
  OPERATOR_WORDS,
  OPERATORS_BY_KIND,
  PLACEHOLDER_HINT,
  RELATION_WORDS,
  SETTABLE_FIELDS,
  VALUELESS,
  fieldsFor,
  type FieldDef,
} from '@/components/automation/vocabulary';
import { ComboSelect } from '@/components/common/ComboSelect';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  useAutomationOptions,
  useAutomationRules,
  useDeleteAutomationRule,
  useDryRunRule,
  useRuleFirings,
  useSaveAutomationRule,
} from '@/hooks/useAutomation';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type {
  AutomationOptions,
  AutomationRule,
  AutomationRuleInput,
  ID,
  PersonSpec,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  RuleEventKind,
  RuleFieldValue,
  RuleFiringView,
  RuleRelation,
  RuleSubjectType,
} from '@/types';
import { describeError } from './shared-format';

/**
 * Automation rules (BR-216, BR-217, BR-219), as an administrator defines them.
 *
 * A rule watches work package or project events, tests the item, and when the
 * conditions hold acts — as EPM's automation account, so OpenProject journals
 * the change under it. A dry run shows what a rule would have done over the
 * last days without doing any of it; every firing is logged with what each
 * action did.
 */

const blankRule = (): AutomationRuleInput => ({
  name: '',
  description: '',
  active: true,
  subjectType: 'work_package',
  events: ['work_package.created', 'work_package.updated'],
  projectIds: [],
  conditions: { match: 'all', conditions: [] },
  fireMode: 'enter',
  actions: [],
});

const toInput = (rule: AutomationRule): AutomationRuleInput => ({
  name: rule.name,
  description: rule.description ?? '',
  active: rule.active,
  subjectType: rule.subjectType,
  events: rule.events,
  projectIds: rule.projectIds,
  conditions: rule.conditions,
  fireMode: rule.fireMode,
  actions: rule.actions,
});

export default function RulesPage() {
  const { can } = useAuth();
  const allowed = can('rules:configure');
  const rules = useAutomationRules(allowed);
  const options = useAutomationOptions(allowed);
  const save = useSaveAutomationRule();
  const remove = useDeleteAutomationRule();
  const [editing, setEditing] = useState<{ id?: ID; input: AutomationRuleInput }>();
  const [logFor, setLogFor] = useState<AutomationRule>();

  if (!allowed) {
    return (
      <Alert tone="neutral" title={t('Rules are configured by administrators')}>
        {t('Defining what rules do across projects needs the rules configuration permission.')}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <AutomationStatusCard />

      <Card>
        <CardHeader
          variant="compact"
          actions={
            <Button size="sm" onClick={() => setEditing({ input: blankRule() })} disabled={!options.data}>
              <Plus className="h-3.5 w-3.5" />
              {t('New rule')}
            </Button>
          }
        >
          <CardTitle>{t('Rules')}</CardTitle>
          <CardDescription>{t('What happens when work or a project changes. Each firing is logged.')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={rules.isLoading}
            isError={rules.isError}
            error={rules.error}
            onRetry={() => rules.refetch()}
            errorTitle={t('Unable to load the rules')}
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(rules.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={Workflow}
                title={t('No rules yet')}
                description={t('A rule can triage new work, chase stalled items or tell people when a project turns red.')}
              />
            }
          >
            <ul className="divide-y divide-border">
              {(rules.data ?? []).map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span dir="auto">{rule.name}</span>
                      {rule.active ? (
                        <Badge tone="success" size="sm">
                          {t('On')}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="sm">
                          {t('Off')}
                        </Badge>
                      )}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {summarise(rule, options.data)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="me-2 text-2xs text-muted-foreground">
                      {rule.firingCount
                        ? rule.lastFiredAt
                          ? t('{count, plural, one {Fired # time} other {Fired # times}}, last {when}', {
                              count: rule.firingCount,
                              when: formatRelative(rule.lastFiredAt),
                            })
                          : t('{count, plural, one {Fired # time} other {Fired # times}}', { count: rule.firingCount })
                        : t('Not fired yet')}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setLogFor(rule)}>
                      <ListChecks className="h-3.5 w-3.5" />
                      {t('Log')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ id: rule.id, input: toInput(rule) })}>
                      {t('Edit')}
                    </Button>
                    {rule.firingCount === 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('Delete {name}', { name: rule.name })}
                        disabled={remove.isPending}
                        onClick={() =>
                          remove.mutate(rule.id, {
                            onSuccess: () => toast.success(t('Rule deleted')),
                            onError: (error) => toast.error(t('It could not be deleted'), { description: describeError(error) }),
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
        <RuleEditor
          initial={editing.input}
          isNew={!editing.id}
          options={options.data}
          saving={save.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(input) =>
            save.mutate(
              { id: editing.id, input },
              {
                onSuccess: () => {
                  toast.success(editing.id ? t('Rule saved') : t('Rule created'));
                  setEditing(undefined);
                },
                onError: (error) => toast.error(t('The rule was not saved'), { description: describeError(error) }),
              },
            )
          }
        />
      ) : null}

      {logFor ? <FiringLog rule={logFor} onClose={() => setLogFor(undefined)} /> : null}
    </div>
  );
}

function summarise(rule: AutomationRule, options?: AutomationOptions): string {
  const subject = rule.subjectType === 'project' ? t('Projects') : t('Work packages');
  const scope = rule.projectIds.length
    ? rule.projectIds.length === 1
      ? options?.projects.find((project) => project.id === rule.projectIds[0])?.name ??
        t('{count, plural, one {# project} other {# projects}}', { count: 1 })
      : t('{count, plural, one {# project} other {# projects}}', { count: rule.projectIds.length })
    : t('every project');
  const conditions = rule.conditions.conditions.length;
  return [
    subject,
    scope,
    t('{count, plural, =0 {no conditions} one {# condition} other {# conditions}}', { count: conditions }),
    rule.actions.map((action) => ACTION_WORDS[action.type].toLowerCase()).join(', '),
  ].join(' · ');
}

/* -------------------------------------------------------------------------- */
/* The editor                                                                  */
/* -------------------------------------------------------------------------- */

function problemsOf(rule: AutomationRuleInput): string[] {
  const found: string[] = [];
  if (!rule.name.trim()) found.push(t('Give the rule a name.'));
  if (rule.events.length === 0) found.push(t('Choose at least one event.'));
  if (rule.actions.length === 0) found.push(t('Add at least one action.'));
  rule.conditions.conditions.forEach((condition, index) => {
    const position = index + 1;
    if ((condition.operator === 'in' || condition.operator === 'not_in') && !(Array.isArray(condition.value) && condition.value.length)) {
      found.push(t('Condition {position, number}: choose at least one value.', { position }));
    }
    if (DAY_COUNT.has(condition.operator) && typeof condition.value !== 'number') {
      found.push(t('Condition {position, number}: give a number of days.', { position }));
    }
    if ((condition.operator === 'on_or_before' || condition.operator === 'on_or_after') && !/^\d{4}-\d{2}-\d{2}$/.test(String(condition.value ?? ''))) {
      found.push(t('Condition {position, number}: choose a date.', { position }));
    }
    if ((condition.operator === 'contains' || condition.operator === 'not_contains') && !String(condition.value ?? '').trim()) {
      found.push(t('Condition {position, number}: give some text to look for.', { position }));
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(condition.operator) && typeof condition.value !== 'number') {
      found.push(t('Condition {position, number}: compare with a number.', { position }));
    }
  });
  rule.actions.forEach((action, index) => {
    const position = index + 1;
    if (action.type === 'notify') {
      if (action.recipients.length === 0) found.push(t('Action {position, number}: say who to notify.', { position }));
      if (!action.title.trim() || !action.message.trim()) {
        found.push(t('Action {position, number}: a notification needs a title and a message.', { position }));
      }
    }
    if (action.type === 'create_work_package' && !action.subject.trim()) {
      found.push(t('Action {position, number}: give the new work package a subject.', { position }));
    }
    if (action.type === 'call_endpoint' && !/^https?:\/\/.+/.test(action.url.trim())) {
      found.push(t('Action {position, number}: give the endpoint\'s URL.', { position }));
    }
  });
  return found;
}

function RuleEditor({
  initial,
  isNew,
  options,
  saving,
  onClose,
  onSave,
}: {
  initial: AutomationRuleInput;
  isNew: boolean;
  options: AutomationOptions;
  saving: boolean;
  onClose: () => void;
  onSave: (input: AutomationRuleInput) => void;
}) {
  const [draft, setDraft] = useState<AutomationRuleInput>(initial);
  const set = (patch: Partial<AutomationRuleInput>) => setDraft((was) => ({ ...was, ...patch }));
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const fields = fieldsFor(draft.subjectType, options);

  const setCondition = (index: number, next: RuleCondition) =>
    set({ conditions: { ...draft.conditions, conditions: draft.conditions.conditions.map((one, i) => (i === index ? next : one)) } });
  const setAction = (index: number, next: RuleAction) => set({ actions: draft.actions.map((one, i) => (i === index ? next : one)) });
  const moveAction = (index: number, by: number) => {
    const actions = [...draft.actions];
    const [moved] = actions.splice(index, 1);
    actions.splice(index + by, 0, moved!);
    set({ actions });
  };

  const changeSubject = (subjectType: RuleSubjectType) =>
    set({
      subjectType,
      events: subjectType === 'project' ? ['project.health_changed'] : ['work_package.created', 'work_package.updated'],
      conditions: { match: 'all', conditions: [] },
      actions: draft.actions.filter((action) => ACTIONS_BY_SUBJECT[subjectType].includes(action.type)),
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('New rule') : t('Edit rule')}</DialogTitle>
          <DialogDescription>{t('When one of its events happens to an item that meets the conditions, the actions run in order.')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-6 overflow-y-auto pe-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rule-name" required>
                {t('Name')}
              </Label>
              <Input id="rule-name" value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} placeholder={t('e.g. Triage high-priority risks')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('Watches')}</Label>
              <Select value={draft.subjectType} onValueChange={(value) => changeSubject(value as RuleSubjectType)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="work_package">{t('Work packages')}</SelectItem>
                  <SelectItem value="project">{t('Projects')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-description">{t('Description')}</Label>
            <Textarea id="rule-description" rows={2} maxLength={1000} value={draft.description ?? ''} onChange={(event) => set({ description: event.target.value })} dir="auto" />
          </div>

          <section className="space-y-2">
            <p className="text-xs font-semibold">{t('When')}</p>
            <div className="flex flex-wrap gap-4">
              {EVENTS_BY_SUBJECT[draft.subjectType].map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={draft.events.includes(event)}
                    onCheckedChange={(checked) =>
                      set({ events: checked ? [...draft.events, event] : draft.events.filter((one) => one !== event) })
                    }
                  />
                  {EVENT_WORDS[event as RuleEventKind]}
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('In projects')}</Label>
                <MultiSelect
                  label={t('Projects')}
                  options={options.projects}
                  selected={options.projects.filter((project) => draft.projectIds.includes(project.id))}
                  onChange={(selected) => set({ projectIds: selected.map((project) => project.id) })}
                  placeholder={t('Every project')}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('Fires')}</Label>
                <Select value={draft.fireMode} onValueChange={(value) => set({ fireMode: value as 'enter' | 'every' })}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="enter">{t('Once, as an item starts to match')}</SelectItem>
                    <SelectItem value="every">{t('On every matching change')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold">{t('If')}</p>
              <Select
                value={draft.conditions.match}
                onValueChange={(match) => set({ conditions: { ...draft.conditions, match: match as 'all' | 'any' } })}
              >
                <SelectTrigger className="h-7 w-auto gap-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('all of these hold')}</SelectItem>
                  <SelectItem value="any">{t('any of these holds')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.conditions.conditions.length === 0 ? (
              <FieldHint>
                {draft.subjectType === 'project'
                  ? t('No conditions: every project in scope matches.')
                  : t('No conditions: every work package in scope matches.')}
              </FieldHint>
            ) : null}
            {draft.conditions.conditions.map((condition, index) => (
              <ConditionRow
                key={index}
                condition={condition}
                fields={fields}
                options={options}
                onChange={(next) => setCondition(index, next)}
                onRemove={() =>
                  set({ conditions: { ...draft.conditions, conditions: draft.conditions.conditions.filter((_, i) => i !== index) } })
                }
              />
            ))}
            {draft.conditions.conditions.length < 20 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const first = fields[0]!;
                  set({
                    conditions: {
                      ...draft.conditions,
                      conditions: [...draft.conditions.conditions, freshCondition(first)],
                    },
                  });
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Add a condition')}
              </Button>
            ) : null}
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold">{t('Then')}</p>
            {draft.actions.map((action, index) => (
              <ActionRow
                key={index}
                index={index}
                count={draft.actions.length}
                action={action}
                subjectType={draft.subjectType}
                options={options}
                onChange={(next) => setAction(index, next)}
                onMove={(by) => moveAction(index, by)}
                onRemove={() => set({ actions: draft.actions.filter((_, i) => i !== index) })}
              />
            ))}
            {draft.actions.length < 10 ? (
              <div className="w-64">
                <Select value="" onValueChange={(type) => set({ actions: [...draft.actions, freshAction(type as RuleAction['type'], draft.subjectType, options)] })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t('Add an action…')} />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIONS_BY_SUBJECT[draft.subjectType].map((type) => (
                      <SelectItem key={type} value={type}>
                        {ACTION_WORDS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </section>

          <DryRunPanel draft={draft} disabled={problems.length > 0} />

          <label className="flex items-center gap-2 text-xs">
            <Switch checked={draft.active} onCheckedChange={(active) => set({ active })} aria-label={t('Active')} />
            {t('On')}
          </label>

          {problems.length > 0 ? (
            <Alert tone="warning" title={t('Before it can be saved')}>
              <ul className="list-disc ps-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button loading={saving} disabled={problems.length > 0} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            {isNew ? t('Create rule') : t('Save rule')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

function freshCondition(field: FieldDef): RuleCondition {
  const operator = OPERATORS_BY_KIND[field.kind][0]!;
  return { field: field.id, operator, value: defaultValue(field, operator) };
}

function defaultValue(field: FieldDef, operator: RuleConditionOperator): RuleCondition['value'] {
  if (VALUELESS.has(operator)) return undefined;
  if (operator === 'in' || operator === 'not_in') return [];
  if (DAY_COUNT.has(operator)) return 3;
  if (field.kind === 'status_category') return 'open';
  if (field.kind === 'boolean') return true;
  return undefined;
}

function ConditionRow({
  condition,
  fields,
  options,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  fields: FieldDef[];
  options: AutomationOptions;
  onChange: (next: RuleCondition) => void;
  onRemove: () => void;
}) {
  const users = useUsers();
  const field = fields.find((one) => one.id === condition.field) ?? fields[0]!;
  const operators = OPERATORS_BY_KIND[field.kind];

  const listFor = (): { id: string; name: string }[] => {
    switch (field.options) {
      case 'types':
        return options.types;
      case 'statuses':
        return options.statuses;
      case 'priorities':
        return options.priorities;
      case 'projects':
        return options.projects;
      case 'portfolios':
        return options.portfolios;
      case 'users':
        return (users.data ?? []).map((user) => ({ id: user.id, name: user.name }));
      case 'health':
        return Object.entries(HEALTH_WORDS).map(([id, name]) => ({ id, name }));
      default:
        return [];
    }
  };

  const numeric = field.kind === 'number' || field.kind === 'custom_number' || DAY_COUNT.has(condition.operator);
  const value = (() => {
    if (VALUELESS.has(condition.operator)) return null;
    if (condition.operator === 'in' || condition.operator === 'not_in') {
      const list = listFor();
      return (
        <MultiSelect
          label={t('Values')}
          options={list}
          selected={list.filter((item) => Array.isArray(condition.value) && condition.value.includes(item.id))}
          onChange={(selected) => onChange({ ...condition, value: selected.map((item) => item.id) })}
          placeholder={t('Choose…')}
        />
      );
    }
    if (field.kind === 'status_category') {
      return (
        <Select value={String(condition.value ?? 'open')} onValueChange={(next) => onChange({ ...condition, value: next })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t('Open')}</SelectItem>
            <SelectItem value="closed">{t('Closed')}</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (field.kind === 'boolean') {
      return (
        <Select value={condition.value === false ? 'no' : 'yes'} onValueChange={(next) => onChange({ ...condition, value: next === 'yes' })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="yes">{t('Yes')}</SelectItem>
            <SelectItem value="no">{t('No')}</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (condition.operator === 'on_or_before' || condition.operator === 'on_or_after') {
      return (
        <Input
          type="date"
          aria-label={t('Date')}
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
          className="h-8 text-xs"
        />
      );
    }
    if (numeric) {
      return (
        <Input
          type="number"
          aria-label={DAY_COUNT.has(condition.operator) ? t('Days') : t('Number')}
          value={typeof condition.value === 'number' ? condition.value : ''}
          onChange={(event) => onChange({ ...condition, value: event.target.value === '' ? undefined : Number(event.target.value) })}
          className="h-8 text-xs"
        />
      );
    }
    return (
      <Input
        aria-label={t('Text')}
        value={typeof condition.value === 'string' ? condition.value : ''}
        maxLength={500}
        onChange={(event) => onChange({ ...condition, value: event.target.value })}
        className="h-8 text-xs"
      />
    );
  })();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
      <div className="w-44">
        <Select
          value={field.id}
          onValueChange={(id) => {
            const next = fields.find((one) => one.id === id);
            if (next) onChange(freshCondition(next));
          }}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t('Field')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fields.map((one) => (
              <SelectItem key={one.id} value={one.id}>
                {one.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-52">
        <Select
          value={condition.operator}
          onValueChange={(operator) =>
            onChange({ ...condition, operator: operator as RuleConditionOperator, value: defaultValue(field, operator as RuleConditionOperator) })
          }
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t('Comparison')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {OPERATOR_WORDS[operator]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-48 flex-1">{value}</div>
      <Button size="icon-sm" variant="ghost" aria-label={t('Remove condition')} onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

const ONE_PERSON: PersonSpec['kind'][] = ['user', 'responsible', 'author', 'project_owner', 'team_lead', 'department_manager'];
const WORK_PEOPLE: PersonSpec['kind'][] = [
  'user',
  'assignee',
  'responsible',
  'author',
  'project_owner',
  'team_lead',
  'department_manager',
  'project_role',
];
const PROJECT_PEOPLE: PersonSpec['kind'][] = ['user', 'project_owner', 'project_role'];

function freshAction(type: RuleAction['type'], subjectType: RuleSubjectType, options: AutomationOptions): RuleAction {
  switch (type) {
    case 'assign':
      return { type, to: { kind: 'project_owner' } };
    case 'notify':
      return {
        type,
        recipients: [{ kind: subjectType === 'project' ? 'project_owner' : 'assignee' }],
        title: subjectType === 'project' ? '{{project}} is {{health}}' : '{{key}} {{subject}}',
        message: '',
        severity: 'info',
      };
    case 'set_status':
      return { type, statusId: options.statuses[0]?.id ?? '' };
    case 'set_field':
      return { type, field: 'dueDate', value: { relativeDays: 2, from: 'today' } };
    case 'create_work_package':
      return {
        type,
        typeId: options.types[0]?.id ?? '',
        subject: subjectType === 'project' ? 'Recovery plan for {{project}}' : 'Follow up: {{subject}}',
        relation: subjectType === 'project' ? 'none' : 'relates',
      };
    case 'call_endpoint':
      return { type, url: '' };
  }
}

function ActionRow({
  index,
  count,
  action,
  subjectType,
  options,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  action: RuleAction;
  subjectType: RuleSubjectType;
  options: AutomationOptions;
  onChange: (next: RuleAction) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const users = useUsers();

  const body = (() => {
    switch (action.type) {
      case 'assign': {
        const nobody = action.to.kind === 'nobody';
        return (
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <Select
              value={nobody ? 'nobody' : 'person'}
              onValueChange={(mode) => onChange({ ...action, to: mode === 'nobody' ? { kind: 'nobody' } : { kind: 'project_owner' } })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="person">{t('To')}</SelectItem>
                <SelectItem value="nobody">{t('To nobody (unassign)')}</SelectItem>
              </SelectContent>
            </Select>
            {nobody ? null : (
              <PersonPicker
                single
                kinds={ONE_PERSON}
                options={options}
                value={[action.to as PersonSpec]}
                onChange={(people) => onChange({ ...action, to: people[0] ?? { kind: 'project_owner' } })}
              />
            )}
          </div>
        );
      }
      case 'notify':
        return (
          <div className="space-y-2">
            <PersonPicker
              kinds={subjectType === 'project' ? PROJECT_PEOPLE : WORK_PEOPLE}
              options={options}
              value={action.recipients}
              onChange={(recipients) => onChange({ ...action, recipients })}
              label={t('Who to notify')}
            />
            <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
              <Input aria-label={t('Title')} value={action.title} maxLength={200} onChange={(event) => onChange({ ...action, title: event.target.value })} className="h-8 text-xs" placeholder={t('Title')} />
              <Select value={action.severity ?? 'info'} onValueChange={(severity) => onChange({ ...action, severity: severity as 'info' | 'warning' | 'critical' })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">{t('Information')}</SelectItem>
                  <SelectItem value="warning">{t('Warning')}</SelectItem>
                  <SelectItem value="critical">{t('Critical')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea aria-label={t('Message')} rows={2} maxLength={2000} value={action.message} onChange={(event) => onChange({ ...action, message: event.target.value })} placeholder={t('Message')} dir="auto" />
            <FieldHint>{PLACEHOLDER_HINT}</FieldHint>
          </div>
        );
      case 'set_status':
        return (
          <Select value={action.statusId} onValueChange={(statusId) => onChange({ ...action, statusId })}>
            <SelectTrigger className="h-8 w-64 text-xs">
              <SelectValue placeholder={t('Choose a status')} />
            </SelectTrigger>
            <SelectContent>
              {options.statuses.map((status) => (
                <SelectItem key={status.id} value={status.id}>
                  {status.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'set_field':
        return <SetFieldEditor action={action} options={options} users={(users.data ?? []).map((user) => ({ id: user.id, name: user.name }))} onChange={onChange} />;
      case 'create_work_package':
        return (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
              <Select value={action.typeId} onValueChange={(typeId) => onChange({ ...action, typeId })}>
                <SelectTrigger className="h-8 text-xs" aria-label={t('Type')}>
                  <SelectValue placeholder={t('Type')} />
                </SelectTrigger>
                <SelectContent>
                  {options.types.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input aria-label={t('Subject')} value={action.subject} maxLength={255} onChange={(event) => onChange({ ...action, subject: event.target.value })} className="h-8 text-xs" placeholder={t('Subject')} />
            </div>
            <Textarea aria-label={t('Description')} rows={2} maxLength={5000} value={action.description ?? ''} onChange={(event) => onChange({ ...action, description: event.target.value || undefined })} placeholder={t('Description (optional)')} dir="auto" />
            <div className="grid gap-2 sm:grid-cols-3">
              {subjectType === 'work_package' ? (
                <Select value={action.relation} onValueChange={(relation) => onChange({ ...action, relation: relation as RuleRelation })}>
                  <SelectTrigger className="h-8 text-xs" aria-label={t('Link')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RELATION_WORDS) as RuleRelation[]).map((relation) => (
                      <SelectItem key={relation} value={relation}>
                        {RELATION_WORDS[relation]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Input
                type="number"
                aria-label={t('Due in days')}
                min={0}
                value={action.dueInDays ?? ''}
                onChange={(event) => onChange({ ...action, dueInDays: event.target.value === '' ? undefined : Number(event.target.value) })}
                className="h-8 text-xs"
                placeholder={t('Due in … days (optional)')}
              />
              <PersonPicker
                single
                kinds={subjectType === 'project' ? ['user', 'project_owner'] : ONE_PERSON}
                options={options}
                value={action.assignee ? [action.assignee] : []}
                onChange={(people) => onChange({ ...action, assignee: people[0] })}
                emptyText={t('Unassigned')}
                label={t('Assign it to')}
              />
            </div>
            <FieldHint>{PLACEHOLDER_HINT}</FieldHint>
          </div>
        );
      case 'call_endpoint':
        return (
          <div className="space-y-1.5">
            <Input aria-label="URL" value={action.url} maxLength={2000} onChange={(event) => onChange({ ...action, url: event.target.value })} className="h-8 text-xs" placeholder="https://hooks.example.com/epm" />
            <FieldHint>
              {t('A JSON POST describing the item and the rule. Public https endpoints only, unless the host is allow-listed.')}
            </FieldHint>
          </div>
        );
    }
  })();

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs text-muted-foreground">{index + 1}</span>
        <p className="flex-1 text-xs font-medium">{ACTION_WORDS[action.type]}</p>
        <Button size="icon-sm" variant="ghost" aria-label={t('Move up')} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t('Move down')} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t('Remove action')} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {body}
    </div>
  );
}

function SetFieldEditor({
  action,
  options,
  users,
  onChange,
}: {
  action: Extract<RuleAction, { type: 'set_field' }>;
  options: AutomationOptions;
  users: { id: string; name: string }[];
  onChange: (next: RuleAction) => void;
}) {
  const fields = [
    ...SETTABLE_FIELDS,
    ...options.customFields.map((field) => ({ id: field.id, label: field.name })),
  ];
  const custom = options.customFields.find((field) => field.id === action.field);
  const isDate = action.field === 'dueDate' || action.field === 'startDate';
  const relative = typeof action.value === 'object' && action.value !== null;
  const dateMode = action.value === null ? 'clear' : relative ? 'relative' : 'fixed';

  const reset = (field: string): RuleFieldValue => {
    if (field === 'dueDate' || field === 'startDate') return { relativeDays: 2, from: 'today' };
    if (field === 'priority') return options.priorities[0]?.id ?? '';
    if (field === 'responsible') return null;
    if (field === 'percentageDone' || field === 'estimatedHours') return 0;
    return '';
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
      <Select value={action.field} onValueChange={(field) => onChange({ ...action, field, value: reset(field) })}>
        <SelectTrigger className="h-8 text-xs" aria-label={t('Field')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem key={field.id} value={field.id}>
              {field.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {action.field === 'priority' ? (
        <Select value={String(action.value ?? '')} onValueChange={(value) => onChange({ ...action, value })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t('Priority')} />
          </SelectTrigger>
          <SelectContent>
            {options.priorities.map((priority) => (
              <SelectItem key={priority.id} value={priority.id}>
                {priority.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : isDate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={dateMode}
            onValueChange={(mode) =>
              onChange({
                ...action,
                value: mode === 'clear' ? null : mode === 'fixed' ? new Date().toISOString().slice(0, 10) : { relativeDays: 2, from: 'today' },
              })
            }
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relative">{t('Days from')}</SelectItem>
              <SelectItem value="fixed">{t('On a date')}</SelectItem>
              <SelectItem value="clear">{t('Clear it')}</SelectItem>
            </SelectContent>
          </Select>
          {relative && typeof action.value === 'object' && action.value ? (
            <>
              <Input
                type="number"
                aria-label={t('Days')}
                value={action.value.relativeDays}
                onChange={(event) =>
                  onChange({ ...action, value: { ...(action.value as { relativeDays: number }), relativeDays: Number(event.target.value) || 0 } })
                }
                className="h-8 w-20 text-xs"
              />
              <Select
                value={action.value.from ?? 'today'}
                onValueChange={(from) => onChange({ ...action, value: { ...(action.value as { relativeDays: number }), from: from as 'today' } })}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">{t('today')}</SelectItem>
                  <SelectItem value="startDate">{t('its start date')}</SelectItem>
                  <SelectItem value="dueDate">{t('its due date')}</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : dateMode === 'fixed' ? (
            <Input type="date" aria-label={t('Date')} value={String(action.value ?? '')} onChange={(event) => onChange({ ...action, value: event.target.value })} className="h-8 w-44 text-xs" />
          ) : null}
        </div>
      ) : action.field === 'responsible' ? (
        <ComboSelect
          label={t('Accountable')}
          options={users}
          value={typeof action.value === 'string' ? action.value : undefined}
          onChange={(value) => onChange({ ...action, value: value ?? null })}
          placeholder={t('Clear it')}
          clearable
        />
      ) : (
        <Input
          type={action.field === 'percentageDone' || action.field === 'estimatedHours' || custom?.numeric ? 'number' : 'text'}
          aria-label={t('Value')}
          value={action.value === null || typeof action.value === 'object' ? '' : String(action.value)}
          onChange={(event) =>
            onChange({
              ...action,
              value:
                action.field === 'percentageDone' || action.field === 'estimatedHours' || custom?.numeric
                  ? Number(event.target.value)
                  : event.target.value,
            })
          }
          className="h-8 text-xs"
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dry run and log (BR-219)                                                    */
/* -------------------------------------------------------------------------- */

function DryRunPanel({ draft, disabled }: { draft: AutomationRuleInput; disabled: boolean }) {
  const dryRun = useDryRunRule();
  const [days, setDays] = useState(7);
  const result = dryRun.data;

  return (
    <section className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="dry-run-days">{t('Dry run over the last')}</Label>
          <div className="flex items-center gap-2">
            <Input id="dry-run-days" type="number" min={1} max={90} value={days} onChange={(event) => setDays(Number(event.target.value) || 7)} className="h-8 w-20 text-xs" />
            <span className="text-xs text-muted-foreground">{t('days')}</span>
          </div>
        </div>
        <Button size="sm" variant="secondary" loading={dryRun.isPending} disabled={disabled} onClick={() => dryRun.mutate({ rule: draft, windowDays: days })}>
          <FlaskConical className="h-3.5 w-3.5" />
          {t('Try it')}
        </Button>
        <FieldHint className="pb-1.5">{t('Shows what the rule would have done. Changes nothing, sends nothing, logs nothing.')}</FieldHint>
      </div>
      {dryRun.isError ? <Alert tone="danger">{describeError(dryRun.error)}</Alert> : null}
      {result ? (
        <div className="space-y-2">
          <p className="text-xs">
            {result.truncated
              ? t('{matched, number} of {count, plural, one {# item} other {# items}} would match (showing the first ones).', {
                  matched: result.matched,
                  count: result.evaluated,
                })
              : t('{matched, number} of {count, plural, one {# item} other {# items}} would match.', {
                  matched: result.matched,
                  count: result.evaluated,
                })}
          </p>
          {result.items.length > 0 ? (
            <ul className="max-h-60 space-y-2 overflow-y-auto">
              {result.items.map((item) => (
                <li key={`${item.subjectType}-${item.subjectId}`} className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                  <p className="font-medium" dir="auto">
                    {item.title}
                    {item.projectName && item.subjectType === 'work_package' ? (
                      <span className="ms-1.5 font-normal text-muted-foreground">· {item.projectName}</span>
                    ) : null}
                  </p>
                  <ul className="mt-0.5 list-disc ps-4 text-2xs text-muted-foreground">
                    {item.actions.map((action, index) => (
                      <li key={index}>{action}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
          {result.notes.map((note) => (
            <p key={note} className="text-2xs text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const OUTCOME: Record<RuleFiringView['outcome'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  succeeded: { get label() { return t('Succeeded'); }, tone: 'success' },
  partial: { get label() { return t('Partly'); }, tone: 'warning' },
  failed: { get label() { return t('Failed'); }, tone: 'danger' },
  skipped: { get label() { return t('Held back'); }, tone: 'neutral' },
};

function FiringLog({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const firings = useRuleFirings(true, rule.id);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('{name}: firings', { name: rule.name })}</DialogTitle>
          <DialogDescription>{t('Every time the rule fired, newest first, with what each action did.')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto">
          <QueryBoundary
            isLoading={firings.isLoading}
            isError={firings.isError}
            error={firings.error}
            onRetry={() => firings.refetch()}
            errorTitle={t('Unable to load the log')}
            skeleton={<ListSkeleton rows={4} />}
            isEmpty={(firings.data ?? []).length === 0}
            empty={<EmptyState size="inline" icon={ListChecks} title={t('It has not fired yet')} />}
          >
            <ul className="divide-y divide-border">
              {(firings.data ?? []).map((firing) => (
                <li key={firing.id} className="space-y-1.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium">
                      <Link
                        to={firing.subjectType === 'project' ? `/projects/${firing.subjectId}` : `/tasks/${firing.subjectId}`}
                        className="hover:underline"
                        onClick={onClose}
                        dir="auto"
                      >
                        {firing.subjectTitle ?? firing.subjectId}
                      </Link>
                    </p>
                    <div className="flex items-center gap-2">
                      <time className="text-2xs text-muted-foreground" dateTime={firing.firedAt} title={formatDateTime(firing.firedAt)}>
                        {formatRelative(firing.firedAt)}
                      </time>
                      <Badge tone={OUTCOME[firing.outcome].tone} size="sm">
                        {OUTCOME[firing.outcome].label}
                      </Badge>
                    </div>
                  </div>
                  {firing.actions.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      {t('Not run: the rule had already fired five times on this item in ten minutes.')}
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {firing.actions.map((action, index) => (
                        <li key={index} className="flex items-start gap-1.5 text-2xs">
                          {action.outcome === 'done' ? (
                            <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-success" aria-label={t('Done')} />
                          ) : action.outcome === 'failed' ? (
                            <XCircle className="mt-px h-3 w-3 shrink-0 text-danger" aria-label={t('Failed')} />
                          ) : (
                            <CircleSlash className="mt-px h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('Skipped')} />
                          )}
                          <span>
                            {action.summary}
                            {action.error ? <span className="text-danger"> — {action.error}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </QueryBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
