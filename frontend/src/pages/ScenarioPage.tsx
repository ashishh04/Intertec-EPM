import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAdjustScenario, useDeleteScenario, useScenario, useScenarios, useSubmitScenario } from '@/hooks/useScenarios';
import { intlLocale, t } from '@/lib/i18n';
import { formatNumber, formatShortDate } from '@/lib/utils';
import type { ScenarioProfile, ScenarioProjectView, ScenarioView } from '@/types';
import { SCENARIO_STATUS } from './ScenariosPage';

const monthLabel = (month: string) =>
  new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}T00:00:00Z`));
const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/** One scenario: its projects adjusted, its figures against the copy as made, or another scenario, and its approval. */
export default function ScenarioPage() {
  const { id } = useParams<{ id: string }>();
  const scenario = useScenario(id);
  const all = useScenarios();
  const [other, setOther] = useState('captured');
  const otherScenario = useScenario(other !== 'captured' ? other : undefined);
  const submit = useSubmitScenario();
  const remove = useDeleteScenario();
  const navigate = useNavigate();
  const view = scenario.data;
  const editable = view?.status === 'draft' || view?.status === 'rejected';
  const against: { name: string; profile: ScenarioProfile } | null = view
    ? other === 'captured'
      ? { name: t('As copied'), profile: view.captured }
      : otherScenario.data
        ? { name: otherScenario.data.name, profile: otherScenario.data.profile }
        : null
    : null;

  return (
    <QueryBoundary isLoading={scenario.isLoading} isError={scenario.isError} error={scenario.error} onRetry={() => void scenario.refetch()} errorTitle={t('The scenario could not be loaded')} skeleton={<ListSkeleton rows={8} />}>
      {view ? (
        <div className="space-y-5">
          <PageHeader
            title={view.name}
            description={t('Copied {when}. Changes here touch no live data until the scenario is approved.', { when: formatShortDate(view.capturedAt) })}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={SCENARIO_STATUS[view.status].tone}>{SCENARIO_STATUS[view.status].label()}</Badge>
                {editable ? (
                  <>
                    <Button
                      loading={submit.isPending}
                      onClick={() =>
                        submit.mutate(view.id, {
                          onSuccess: () => toast.success(t('Submitted for approval')),
                          onError: (error) => toast.error(t('The scenario was not submitted'), { description: errorText(error) }),
                        })
                      }
                    >
                      <Send className="h-4 w-4" />
                      {t('Submit to apply')}
                    </Button>
                    <Button variant="ghost" aria-label={t('Remove')} onClick={() => remove.mutate(view.id, { onSuccess: () => navigate('/scenarios') })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                ) : null}
              </div>
            }
          />
          {view.status === 'promoted' || view.status === 'rejected' ? (
            <Alert tone={view.status === 'promoted' ? 'success' : 'danger'} title={view.status === 'promoted' ? t('Approved and applied') : t('Rejected')}>
              {view.decision?.comment ?? t('No comment.')}
            </Alert>
          ) : null}
          <ProjectsCard view={view} editable={editable} />
          <Card>
            <CardHeader variant="compact">
              <CardTitle>{t('Compare')}</CardTitle>
              <CardDescription>{t('Capacity demand, spend, delivery and strategic score, side by side.')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <Select value={other} onValueChange={setOther}>
                <SelectTrigger className="w-72" aria-label={t('Compare with')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="captured">{t('As copied')}</SelectItem>
                  {(all.data ?? [])
                    .filter((entry) => entry.id !== view.id)
                    .map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {against ? <Comparison left={{ name: view.name, profile: view.profile }} right={against} /> : null}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </QueryBoundary>
  );
}

function ProjectsCard({ view, editable }: { view: ScenarioView; editable: boolean }) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Projects')}</CardTitle>
        <CardDescription>{t('Move a project by months or days, change its budget or priority, or leave it out.')}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto pt-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-2xs text-muted-foreground">
              <th className="py-1.5 text-start font-medium">{t('Project')}</th>
              <th className="py-1.5 text-start font-medium">{t('Included')}</th>
              <th className="py-1.5 text-start font-medium">{t('Move (months)')}</th>
              <th className="py-1.5 text-start font-medium">{t('Move (days)')}</th>
              <th className="py-1.5 text-start font-medium">{t('Budget')}</th>
              <th className="py-1.5 text-start font-medium">{t('Priority')}</th>
              <th className="py-1.5 text-start font-medium">{t('Dates')}</th>
            </tr>
          </thead>
          <tbody>
            {view.projects.map((project) => (
              <ProjectRow key={project.projectId} scenarioId={view.id} project={project} editable={editable} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function ProjectRow({ scenarioId, project, editable }: { scenarioId: string; project: ScenarioProjectView; editable: boolean }) {
  const adjust = useAdjustScenario();
  const [draft, setDraft] = useState({ months: '', days: '', budget: '', priority: '' });
  useEffect(() => {
    setDraft({
      months: String(project.shiftMonths),
      days: String(project.shiftDays),
      budget: project.budget === null ? '' : String(project.budget),
      priority: String(project.priority),
    });
  }, [project]);
  const save = (input: Parameters<typeof adjust.mutate>[0]['input']) =>
    adjust.mutate({ id: scenarioId, projectId: project.projectId, input }, { onError: (error) => toast.error(t('The change was not saved'), { description: errorText(error) }) });
  const number = (value: string) => (value.trim() === '' ? 0 : Number(value));
  return (
    <tr className="border-b border-border/60">
      <td className="py-1.5" dir="auto">
        {project.name}
      </td>
      <td className="py-1.5">
        <Switch checked={project.included} disabled={!editable} onCheckedChange={(included) => save({ included })} aria-label={t('Included')} />
      </td>
      <td className="py-1.5">
        <Input className="h-8 w-20" inputMode="numeric" disabled={!editable} value={draft.months} onChange={(event) => setDraft({ ...draft, months: event.target.value })} onBlur={() => number(draft.months) !== project.shiftMonths && save({ shiftMonths: number(draft.months) })} />
      </td>
      <td className="py-1.5">
        <Input className="h-8 w-20" inputMode="numeric" disabled={!editable} value={draft.days} onChange={(event) => setDraft({ ...draft, days: event.target.value })} onBlur={() => number(draft.days) !== project.shiftDays && save({ shiftDays: number(draft.days) })} />
      </td>
      <td className="py-1.5">
        <Input
          className="h-8 w-28"
          inputMode="decimal"
          disabled={!editable}
          value={draft.budget}
          onChange={(event) => setDraft({ ...draft, budget: event.target.value })}
          onBlur={() => {
            const budget = draft.budget.trim() === '' ? null : Number(draft.budget);
            if (budget !== project.budget) save({ budget });
          }}
        />
      </td>
      <td className="py-1.5">
        <Select value={draft.priority} disabled={!editable} onValueChange={(value) => save({ priority: Number(value) })}>
          <SelectTrigger className="h-8 w-16">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-1.5 text-2xs text-muted-foreground">
        {project.plannedStart ? `${formatShortDate(project.plannedStart)} – ${formatShortDate(project.plannedFinish)}` : '—'}
      </td>
    </tr>
  );
}

function Comparison({ left, right }: { left: { name: string; profile: ScenarioProfile }; right: { name: string; profile: ScenarioProfile } }) {
  // Every month from the first to the last of either, with none skipped.
  const months = useMemo(() => {
    const all = [...left.profile.months, ...right.profile.months].map((row) => row.month).sort();
    const out: string[] = [];
    if (all.length === 0) return out;
    for (let at = new Date(`${all[0]}T00:00:00Z`); at.toISOString().slice(0, 10) <= all.at(-1)!; at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))) {
      out.push(at.toISOString().slice(0, 10));
    }
    return out;
  }, [left.profile.months, right.profile.months]);
  const cell = (profile: ScenarioProfile, month: string) => profile.months.find((row) => row.month === month);
  const delivery = (profile: ScenarioProfile) => profile.milestones.at(-1)?.date;
  return (
    <div className="space-y-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-2xs text-muted-foreground">
            <th className="py-1.5 text-start font-medium" />
            <th className="py-1.5 text-end font-medium" dir="auto">
              {left.name}
            </th>
            <th className="py-1.5 text-end font-medium" dir="auto">
              {right.name}
            </th>
          </tr>
        </thead>
        <tbody>
          {[
            [t('Hours of work'), formatNumber(left.profile.totals.demand), formatNumber(right.profile.totals.demand)],
            [t('Spend'), formatNumber(left.profile.totals.spend), formatNumber(right.profile.totals.spend)],
            [t('Last milestone'), delivery(left.profile) ? formatShortDate(delivery(left.profile)) : '—', delivery(right.profile) ? formatShortDate(delivery(right.profile)) : '—'],
            [t('Strategic score'), String(left.profile.strategicScore), String(right.profile.strategicScore)],
          ].map(([label, a, b]) => (
            <tr key={label} className="border-b border-border/60">
              <td className="py-1.5">{label}</td>
              <td className="py-1.5 text-end font-mono">{a}</td>
              <td className="py-1.5 text-end font-mono">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-2xs text-muted-foreground">
            <th className="py-1.5 text-start font-medium">{t('Month')}</th>
            <th className="py-1.5 text-end font-medium">{t('Capacity')}</th>
            <th className="py-1.5 text-end font-medium">{t('Demand, this')}</th>
            <th className="py-1.5 text-end font-medium">{t('Demand, other')}</th>
            <th className="py-1.5 text-end font-medium">{t('Spend, this')}</th>
            <th className="py-1.5 text-end font-medium">{t('Spend, other')}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => {
            const a = cell(left.profile, month);
            const b = cell(right.profile, month);
            const over = a && a.demand > a.capacity;
            return (
              <tr key={month} className="border-b border-border/60">
                <td className="py-1.5">{monthLabel(month)}</td>
                <td className="py-1.5 text-end font-mono">{a ?? b ? formatNumber((a ?? b)!.capacity) : '—'}</td>
                <td className={`py-1.5 text-end font-mono ${over ? 'text-destructive' : ''}`}>{formatNumber(a?.demand ?? 0)}</td>
                <td className="py-1.5 text-end font-mono">{formatNumber(b?.demand ?? 0)}</td>
                <td className="py-1.5 text-end font-mono">{formatNumber(a?.spend ?? 0)}</td>
                <td className="py-1.5 text-end font-mono">{formatNumber(b?.spend ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {left.profile.undatedHours > 0 ? <p className="text-2xs text-muted-foreground">{t('{hours} hours of open work have no dates and fall in no month.', { hours: formatNumber(left.profile.undatedHours) })}</p> : null}
    </div>
  );
}
