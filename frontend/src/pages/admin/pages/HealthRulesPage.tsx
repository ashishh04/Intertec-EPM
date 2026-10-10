import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { HealthIndicator } from '@/components/common/StatusBadge';
import { ListSkeleton } from '@/components/common/DataTable';
import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  useHealthRuleHistory,
  useHealthRuleOptions,
  useHealthRules,
  usePreviewHealthRules,
  useSaveHealthRules,
} from '@/hooks/useHealthRules';
import { useUserMap } from '@/hooks/useUsers';
import { HEALTH_CRITERIA_META } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { cn, formatDateTime, formatPercent, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { HealthRulesInput, HealthRulesPreview } from '@/services/api/health';
import type { HealthCriterion, HealthCriterionRule, HealthRules } from '@/types';
import { describeError } from './shared-format';

/**
 * The health rules (BR-204), as an administrator sets them.
 *
 * One row per criterion — whether it is used, the weight it carries and where
 * it turns amber and red — and the rule that turns those into an overall. A
 * save never edits the rules in force: it adds the next version, the change is
 * journalled, and every project is recalculated under it. A preview shows
 * which projects would move before anything is saved.
 *
 * Readable by anyone with access to this page; changing it needs
 * `health:configure`, which is policy for every project and deliberately not
 * the same permission as overriding one.
 */

const UNIT_LABEL: Record<string, string> = {
  get days() { return t('days'); },
  get percent() { return t('% of budget'); },
  count: '',
};

type Draft = HealthRulesInput;

function toDraft(rules: HealthRules): Draft {
  return {
    criteria: structuredClone(rules.criteria),
    redShare: rules.redShare,
    amberShare: rules.amberShare,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function HealthRulesPage() {
  const { can } = useAuth();
  const mayConfigure = can('health:configure');

  const rules = useHealthRules();
  const options = useHealthRuleOptions(mayConfigure);
  const history = useHealthRuleHistory();
  const save = useSaveHealthRules();
  const preview = usePreviewHealthRules();
  const users = useUserMap();

  const [draft, setDraft] = useState<Draft>();
  const [previewResult, setPreviewResult] = useState<HealthRulesPreview>();

  useEffect(() => {
    if (rules.data) setDraft(toDraft(rules.data));
    setPreviewResult(undefined);
  }, [rules.data]);

  const original = rules.data ? toDraft(rules.data) : undefined;
  const dirty = Boolean(draft && original && !sameDraft(draft, original));

  const setCriterion = (key: HealthCriterion, patch: Partial<HealthCriterionRule>) => {
    setDraft((was) =>
      was ? { ...was, criteria: { ...was.criteria, [key]: { ...was.criteria[key], ...patch } } } : was,
    );
    setPreviewResult(undefined);
  };

  // Problems the server would refuse, said before it has to.
  const problems = useMemo(() => {
    if (!draft) return [];
    const found: string[] = [];
    for (const meta of HEALTH_CRITERIA_META) {
      const rule = draft.criteria[meta.key];
      if (!(rule.amberAt > 0)) found.push(t('{criterion}: the amber threshold must be above zero.', { criterion: meta.label }));
      if (rule.redAt < rule.amberAt) found.push(t('{criterion}: the red threshold cannot be below the amber one.', { criterion: meta.label }));
      if (meta.unit === 'count' && (!Number.isInteger(rule.amberAt) || !Number.isInteger(rule.redAt))) {
        found.push(t('{criterion}: thresholds are whole numbers.', { criterion: meta.label }));
      }
    }
    if (!HEALTH_CRITERIA_META.some(({ key }) => draft.criteria[key].enabled && draft.criteria[key].weight > 0)) {
      found.push(t('At least one criterion has to be in use with a weight above zero.'));
    }
    return found;
  }, [draft]);

  // What one criterion alone is worth, so the share thresholds can be read.
  const weightShares = useMemo(() => {
    if (!draft) return [];
    const counted = HEALTH_CRITERIA_META.filter(({ key }) => draft.criteria[key].enabled && draft.criteria[key].weight > 0);
    const total = counted.reduce((sum, { key }) => sum + draft.criteria[key].weight, 0);
    return counted.map((meta) => ({
      label: meta.label,
      share: total > 0 ? Math.round((draft.criteria[meta.key].weight / total) * 100) : 0,
    }));
  }, [draft]);

  const runPreview = () => {
    if (!draft) return;
    preview.mutate(draft, {
      onSuccess: setPreviewResult,
      onError: (error) => toast.error(t('The preview could not run'), { description: describeError(error) }),
    });
  };

  const submit = () => {
    if (!draft) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        setPreviewResult(undefined);
        toast.success(t('Health rules saved as version {version, number}', { version: saved.version }), {
          description: t('Every project is being recalculated under them.'),
        });
      },
      onError: (error) => toast.error(t('The rules were not saved'), { description: describeError(error) }),
    });
  };

  return (
    <div className="space-y-4">
      {!mayConfigure ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('These are the rules every project\'s health is calculated by. Changing them needs the health configuration permission.')}
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={rules.isLoading || !draft}
        isError={rules.isError}
        error={rules.error}
        onRetry={() => rules.refetch()}
        errorTitle={t('Unable to load the health rules')}
        skeleton={<ListSkeleton rows={6} />}
      >
        {draft && rules.data ? (
          <>
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Criteria')}</CardTitle>
                <CardDescription>
                  {t('Each project is measured on these. A criterion turns amber at its amber threshold and red at its red one; its weight is how much it counts towards the overall. A weight of zero shows the criterion without letting it move the overall.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="divide-y divide-border">
                  <div className="hidden grid-cols-[3rem_minmax(0,1fr)_6rem_8rem_8rem] gap-3 pb-2 text-2xs font-medium text-muted-foreground md:grid">
                    <span>{t('Use')}</span>
                    <span>{t('Criterion')}</span>
                    <span>{t('Weight')}</span>
                    <span>{t('Amber at')}</span>
                    <span>{t('Red at')}</span>
                  </div>
                  {HEALTH_CRITERIA_META.map((meta) => {
                    const rule = draft.criteria[meta.key];
                    const unit = UNIT_LABEL[meta.unit];
                    return (
                      <div
                        key={meta.key}
                        className={cn(
                          'grid gap-3 py-3 md:grid-cols-[3rem_minmax(0,1fr)_6rem_8rem_8rem] md:items-center',
                          !rule.enabled && 'opacity-60',
                        )}
                      >
                        <Switch
                          checked={rule.enabled}
                          onCheckedChange={(enabled) => setCriterion(meta.key, { enabled })}
                          disabled={!mayConfigure}
                          aria-label={t('Use {criterion}', { criterion: meta.label })}
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-medium">{meta.label}</p>
                          <p className="text-2xs text-muted-foreground">{meta.hint}</p>
                        </div>
                        <NumberField
                          label={t('{criterion} weight', { criterion: meta.label })}
                          value={rule.weight}
                          onChange={(weight) => setCriterion(meta.key, { weight })}
                          disabled={!mayConfigure || !rule.enabled}
                          min={0}
                          max={100}
                          step={1}
                        />
                        <NumberField
                          label={t('{criterion} amber threshold', { criterion: meta.label })}
                          value={rule.amberAt}
                          suffix={unit}
                          onChange={(amberAt) => setCriterion(meta.key, { amberAt })}
                          disabled={!mayConfigure || !rule.enabled}
                          min={0}
                          step={meta.unit === 'count' ? 1 : 'any'}
                        />
                        <NumberField
                          label={t('{criterion} red threshold', { criterion: meta.label })}
                          value={rule.redAt}
                          suffix={unit}
                          onChange={(redAt) => setCriterion(meta.key, { redAt })}
                          disabled={!mayConfigure || !rule.enabled}
                          min={0}
                          step={meta.unit === 'count' ? 1 : 'any'}
                        />
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Overall')}</CardTitle>
                <CardDescription>
                  {t('The overall is decided by weight, counting only the criteria that could be assessed for a project — one with no budget is judged on the rest rather than read as on budget.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-2">
                <ShareField
                  id="red-share"
                  lead={t('Red when red criteria carry at least')}
                  value={draft.redShare}
                  onChange={(redShare) => {
                    setDraft((was) => (was ? { ...was, redShare } : was));
                    setPreviewResult(undefined);
                  }}
                  disabled={!mayConfigure}
                />
                <ShareField
                  id="amber-share"
                  lead={t('Amber when amber or red criteria carry at least')}
                  value={draft.amberShare}
                  onChange={(amberShare) => {
                    setDraft((was) => (was ? { ...was, amberShare } : was));
                    setPreviewResult(undefined);
                  }}
                  disabled={!mayConfigure}
                />
                {weightShares.length > 0 ? (
                  <FieldHint>
                    {t('With every criterion assessed, each one alone carries: {shares}.', {
                      shares: weightShares
                        .map((item) => `${item.label.toLowerCase()} ${formatPercent(item.share)}`)
                        .join(', '),
                    })}
                  </FieldHint>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('What counts as a high risk')}</CardTitle>
                <CardDescription>
                  {t('Open work packages of these types at these priorities. With nothing chosen, a type is a risk if its name says so, and high means High and above.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t('Risk types')}</Label>
                  <MultiSelect
                    label={t('Risk types')}
                    options={options.data?.types ?? []}
                    selected={(options.data?.types ?? []).filter((type) =>
                      draft.criteria.risks.typeIds.includes(type.id),
                    )}
                    onChange={(selected) => {
                      setDraft((was) =>
                        was
                          ? {
                              ...was,
                              criteria: {
                                ...was.criteria,
                                risks: { ...was.criteria.risks, typeIds: selected.map((item) => item.id) },
                              },
                            }
                          : was,
                      );
                      setPreviewResult(undefined);
                    }}
                    placeholder={t('Types named “Risk”')}
                    disabled={!mayConfigure}
                  />
                  <FieldHint>
                    {options.data
                      ? options.data.defaultRiskTypeIds.length > 0
                        ? t('Nothing chosen means: {names}.', {
                            names: options.data.types
                              .filter((type) => options.data!.defaultRiskTypeIds.includes(type.id))
                              .map((type) => type.name)
                              .join(', '),
                          })
                        : t('No type on this instance is named as a risk, so until one is chosen or created, risks are not assessed.')
                      : null}
                  </FieldHint>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('High priorities')}</Label>
                  <MultiSelect
                    label={t('High priorities')}
                    options={options.data?.priorities ?? []}
                    selected={(options.data?.priorities ?? []).filter((priority) =>
                      draft.criteria.risks.priorityIds.includes(priority.id),
                    )}
                    onChange={(selected) => {
                      setDraft((was) =>
                        was
                          ? {
                              ...was,
                              criteria: {
                                ...was.criteria,
                                risks: { ...was.criteria.risks, priorityIds: selected.map((item) => item.id) },
                              },
                            }
                          : was,
                      );
                      setPreviewResult(undefined);
                    }}
                    placeholder={t('High and above')}
                    disabled={!mayConfigure}
                  />
                  {options.data && options.data.defaultHighPriorityIds.length > 0 ? (
                    <FieldHint>
                      {t('Nothing chosen means: {names}.', {
                        names: options.data.priorities
                          .filter((priority) => options.data!.defaultHighPriorityIds.includes(priority.id))
                          .map((priority) => priority.name)
                          .join(', '),
                      })}
                    </FieldHint>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            {problems.length > 0 ? (
              <Alert tone="warning" title={t('These rules cannot be saved yet')}>
                <ul className="list-disc ps-4">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {mayConfigure ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-2xs text-muted-foreground">
                  {rules.data.version > 0
                    ? rules.data.updatedAt
                      ? t('Version {version, number} is in force, saved {when}.', {
                          version: rules.data.version,
                          when: formatRelative(rules.data.updatedAt),
                        })
                      : t('Version {version, number} is in force.', { version: rules.data.version })
                    : t('The built-in defaults are in force; nothing has been saved yet.')}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={!dirty || save.isPending}
                    onClick={() => {
                      setDraft(original);
                      setPreviewResult(undefined);
                    }}
                  >
                    {t('Discard changes')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!dirty || problems.length > 0}
                    loading={preview.isPending}
                    onClick={runPreview}
                  >
                    {t('Preview impact')}
                  </Button>
                  <Button disabled={!dirty || problems.length > 0} loading={save.isPending} onClick={submit}>
                    {t('Save as version {version, number}', { version: rules.data.version + 1 })}
                  </Button>
                </div>
              </div>
            ) : null}

            {previewResult ? <PreviewCard result={previewResult} /> : null}
          </>
        ) : null}
      </QueryBoundary>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('History')}</CardTitle>
          <CardDescription>{t('Every saved version, with who saved it and what changed.')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={history.isLoading}
            isError={history.isError}
            error={history.error}
            onRetry={() => history.refetch()}
            errorTitle={t('Unable to load the history')}
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(history.data ?? []).length === 0}
            empty={<p className="text-xs text-muted-foreground">{t('No version has been saved yet.')}</p>}
          >
            <ol className="space-y-2">
              {(history.data ?? []).map((entry) => (
                <li key={entry.id} className="text-xs">
                  <p>{entry.summary}</p>
                  <p className="text-2xs text-muted-foreground">
                    {entry.actorId ? users.get(entry.actorId)?.name ?? t('Someone no longer listed') : 'EPM'} ·{' '}
                    {formatDateTime(entry.occurredAt)}
                  </p>
                </li>
              ))}
            </ol>
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  disabled,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number | 'any';
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        className="h-8 w-20 text-xs"
      />
      {suffix ? <span className="text-2xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function ShareField({
  id,
  lead,
  value,
  onChange,
  disabled,
}: {
  id: string;
  lead: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Label htmlFor={id} className="font-normal">
        {lead}
      </Label>
      <Input
        id={id}
        type="number"
        min={1}
        max={100}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
        disabled={disabled}
        className="h-8 w-20 text-xs"
      />
      <span className="text-muted-foreground">{t('% of the weight assessed.')}</span>
    </div>
  );
}

function PreviewCard({ result }: { result: HealthRulesPreview }) {
  const changed = result.projects.filter((row) => row.changed);

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Preview')}</CardTitle>
        <CardDescription>
          {result.changed === 0
            ? t('No project’s overall health would change under these rules.')
            : t('{count, plural, one {# project’s overall health would change. Nothing has been saved.} other {# projects’ overall health would change. Nothing has been saved.}}', { count: result.changed })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-2">
        {result.note ? <Alert tone="neutral">{result.note}</Alert> : null}
        {changed.length > 0 ? (
          <ul className="divide-y divide-border">
            {changed.map((row) => (
              <li key={row.projectId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium" dir="auto">{row.projectName}</p>
                  <p className="text-2xs text-muted-foreground">{row.explanation}</p>
                </div>
                <div className="flex items-center gap-2 text-2xs">
                  <HealthIndicator level={row.current.overall} />
                  <span aria-hidden className="rtl:-scale-x-100">→</span>
                  <HealthIndicator level={row.preview.overall} />
                  <Badge tone="neutral" className="text-2xs">
                    {t('would change')}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
