import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  downloadBatch,
  useBatches,
  useBilling,
  useCashFlow,
  useContract,
  useCreateBatch,
  useCurrencies,
  useForecast,
  useGenerateBilling,
  useMargin,
  usePhasing,
  useRateCards,
  useSaveContract,
  useSavePhasing,
  useSendBatch,
  type FinanceScope,
} from '@/hooks/useFinance';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useProjects } from '@/hooks/useProjects';
import { saveBlob } from '@/lib/download';
import { intlLocale, t } from '@/lib/i18n';
import { formatNumber, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { BillingModel, FinanceBatchStatus, ID } from '@/types';

const MODEL_LABEL: Record<BillingModel, () => string> = {
  time_and_materials: () => t('Time and materials'),
  fixed_price: () => t('Fixed price'),
  non_billable: () => t('Not billed'),
};

const BATCH_LABEL: Record<FinanceBatchStatus, () => string> = {
  ready: () => t('Ready to send'),
  sent: () => t('Sent'),
  acknowledged: () => t('Acknowledged'),
  mismatch: () => t('Does not reconcile'),
  failed: () => t('Failed'),
};

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const monthLabel = (month: string) => new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}T00:00:00Z`));
const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * Finance (Module 11, part 2): planned against actual cash flow (BR-311),
 * margin (BR-318) and the revenue forecast (BR-319) for every project, a
 * portfolio or one project; and for one project its contract, budget phasing
 * (BR-310) and billing (BR-322). Batches of billable items go to the finance
 * system (BR-323). Every figure is in the reporting currency.
 */
export default function FinancePage() {
  const { can } = useAuth();
  const manage = can('finance:manage');
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const portfolioId = params.get('portfolio') ?? undefined;
  const scope: FinanceScope = projectId ? { projectId } : portfolioId ? { portfolioId } : {};
  const projects = useProjects();
  const portfolios = usePortfolios();
  const currencies = useCurrencies();
  const reporting = currencies.data?.reporting ?? '';
  const scopeValue = projectId ? `project:${projectId}` : portfolioId ? `portfolio:${portfolioId}` : 'all';

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Finance')}
        description={t('Cash flow, margin, the revenue forecast and billing, in {currency}.', { currency: reporting })}
        actions={
          <Select
            value={scopeValue}
            onValueChange={(value) => {
              const [kind, id] = value.split(':');
              setParams(kind === 'project' ? { project: id! } : kind === 'portfolio' ? { portfolio: id! } : {});
            }}
          >
            <SelectTrigger className="w-72" aria-label={t('Scope')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Every project')}</SelectItem>
              {(portfolios.data ?? []).map((portfolio) => (
                <SelectItem key={portfolio.id} value={`portfolio:${portfolio.id}`}>
                  {t('Portfolio: {name}', { name: portfolio.name })}
                </SelectItem>
              ))}
              {(projects.data ?? []).map((project) => (
                <SelectItem key={project.id} value={`project:${project.id}`}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <Tabs defaultValue="cash-flow">
        <TabsList>
          <TabsTrigger value="cash-flow">{t('Cash flow')}</TabsTrigger>
          <TabsTrigger value="margin">{t('Margin')}</TabsTrigger>
          <TabsTrigger value="forecast">{t('Revenue forecast')}</TabsTrigger>
          {projectId ? <TabsTrigger value="project">{t('Contract and billing')}</TabsTrigger> : null}
          <TabsTrigger value="batches">{t('Transfers to finance')}</TabsTrigger>
        </TabsList>
        <TabsContent value="cash-flow">
          <CashFlowCard scope={scope} />
        </TabsContent>
        <TabsContent value="margin">
          <MarginCard scope={scope} />
        </TabsContent>
        <TabsContent value="forecast">
          <ForecastCard scope={scope} />
        </TabsContent>
        {projectId ? (
          <TabsContent value="project" className="space-y-4">
            <ContractCard projectId={projectId} manage={manage} />
            <PhasingCard projectId={projectId} manage={manage} />
            <BillingCard projectId={projectId} manage={manage} />
          </TabsContent>
        ) : null}
        <TabsContent value="batches">
          <BatchesCard projectId={projectId} manage={manage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CashFlowCard({ scope }: { scope: FinanceScope }) {
  const flow = useCashFlow(scope);
  const series = flow.data?.combined;
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Planned against actual cash flow')}</CardTitle>
        <CardDescription>{t('The phased budget against what was spent, month by month and cumulative: labour at people’s rates and every other cost.')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary isLoading={flow.isLoading} isError={flow.isError} error={flow.error} onRetry={() => void flow.refetch()} errorTitle={t('The cash flow could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
          {series ? (
            <div className="space-y-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-2xs text-muted-foreground">
                    <th className="py-1.5 text-start font-medium">{t('Month')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Planned')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Actual')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Planned to date')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Actual to date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {series.points.map((point) => (
                    <tr key={point.month} className="border-b border-border/60">
                      <td className="py-1.5">{monthLabel(point.month)}</td>
                      <td className="py-1.5 text-end font-mono">{money(point.planned)}</td>
                      <td className="py-1.5 text-end font-mono">{money(point.actual)}</td>
                      <td className="py-1.5 text-end font-mono">{money(point.cumulativePlanned)}</td>
                      <td className="py-1.5 text-end font-mono">{money(point.cumulativeActual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-2xs text-muted-foreground">
                {flow.data!.reconciliation.reconciles
                  ? t('Actual to date reconciles with the actual cost of {total}.', { total: money(flow.data!.reconciliation.totalActualCost) })
                  : t('Actual to date ({cumulative}) does not reconcile with the actual cost of {total}.', {
                      cumulative: money(flow.data!.reconciliation.cumulativeAtEnd),
                      total: money(flow.data!.reconciliation.totalActualCost),
                    })}
                {series.totals.uncostedHours > 0 ? ` ${t('{hours} hours have no rate and are in no figure.', { hours: formatNumber(series.totals.uncostedHours) })}` : ''}
              </p>
            </div>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function MarginCard({ scope }: { scope: FinanceScope }) {
  const margin = useMargin(scope);
  const row = (label: string, side: { revenue: number | null; cost: number | null; margin: number | null; percent: number | null }) => (
    <>
      <td className="py-1.5 text-end font-mono">{money(side.revenue)}</td>
      <td className="py-1.5 text-end font-mono">{money(side.cost)}</td>
      <td className="py-1.5 text-end font-mono" title={label}>
        {money(side.margin)}
        {side.percent === null ? '' : ` (${formatNumber(side.percent)}%)`}
      </td>
    </>
  );
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Estimated against actual margin')}</CardTitle>
        <CardDescription>{t('Estimated: the contract value, or the estimates at bill rates, less the budget. Actual: revenue earned less the cost spent.')}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto pt-4">
        <QueryBoundary isLoading={margin.isLoading} isError={margin.isError} error={margin.error} onRetry={() => void margin.refetch()} errorTitle={t('The margin could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Project')}</th>
                <th className="py-1.5 text-start font-medium">{t('Billing')}</th>
                <th className="py-1.5 text-end font-medium">{t('Estimated revenue')}</th>
                <th className="py-1.5 text-end font-medium">{t('Estimated cost')}</th>
                <th className="py-1.5 text-end font-medium">{t('Estimated margin')}</th>
                <th className="py-1.5 text-end font-medium">{t('Revenue earned')}</th>
                <th className="py-1.5 text-end font-medium">{t('Cost spent')}</th>
                <th className="py-1.5 text-end font-medium">{t('Actual margin')}</th>
              </tr>
            </thead>
            <tbody>
              {(margin.data?.projects ?? []).map((project) => (
                <tr key={project.projectId} className="border-b border-border/60">
                  <td className="py-1.5" dir="auto">
                    {project.name}
                    {project.unpricedHours > 0 ? <span className="ms-1 text-2xs text-muted-foreground">{t('({hours} h unpriced)', { hours: formatNumber(project.unpricedHours) })}</span> : null}
                  </td>
                  <td className="py-1.5">
                    {MODEL_LABEL[project.billingModel]()} · {project.projectCurrency}
                  </td>
                  {row(t('Estimated margin'), project.margin.estimated)}
                  {row(t('Actual margin'), project.margin.actual)}
                </tr>
              ))}
              {margin.data ? (
                <tr className="font-medium">
                  <td className="py-1.5" colSpan={2}>
                    {t('Together')}
                  </td>
                  {row(t('Estimated margin'), margin.data.combined.estimated)}
                  {row(t('Actual margin'), margin.data.combined.actual)}
                </tr>
              ) : null}
            </tbody>
          </table>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function ForecastCard({ scope }: { scope: FinanceScope }) {
  const forecast = useForecast(scope);
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Labour revenue forecast')}</CardTitle>
        <CardDescription>{t('The hours planned each month at their bill rates, weighted by how sure each project is, by its status.')}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto pt-4">
        <QueryBoundary isLoading={forecast.isLoading} isError={forecast.isError} error={forecast.error} onRetry={() => void forecast.refetch()} errorTitle={t('The forecast could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
          {forecast.data ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="py-1.5 text-start font-medium">{t('Project')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Confidence')}</th>
                  {forecast.data.months.map((month) => (
                    <th key={month} className="py-1.5 text-end font-medium">
                      {monthLabel(month)}
                    </th>
                  ))}
                  <th className="py-1.5 text-end font-medium">{t('Weighted')}</th>
                </tr>
              </thead>
              <tbody>
                {forecast.data.projects.map((project) => (
                  <tr key={project.projectId} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      {project.name}
                    </td>
                    <td className="py-1.5 text-end">{formatNumber(project.confidence)}%</td>
                    {project.months.map((month) => (
                      <td key={month.month} className="py-1.5 text-end font-mono">
                        {money(month.weighted)}
                      </td>
                    ))}
                    <td className="py-1.5 text-end font-mono">{money(project.total.weighted)}</td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="py-1.5" colSpan={2}>
                    {t('Together')}
                  </td>
                  {forecast.data.combined.map((month) => (
                    <td key={month.month} className="py-1.5 text-end font-mono">
                      {money(month.weighted)}
                    </td>
                  ))}
                  <td className="py-1.5 text-end font-mono">{money(forecast.data.total.weighted)}</td>
                </tr>
              </tbody>
            </table>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function ContractCard({ projectId, manage }: { projectId: ID; manage: boolean }) {
  const contract = useContract(projectId);
  const currencies = useCurrencies();
  const cards = useRateCards();
  const save = useSaveContract();
  const [draft, setDraft] = useState({ currency: '', contractValue: '', billingModel: 'time_and_materials' as BillingModel, rateCardId: '' });
  useEffect(() => {
    if (contract.data) {
      setDraft({
        currency: contract.data.currency,
        contractValue: contract.data.contractValue === null ? '' : String(contract.data.contractValue),
        billingModel: contract.data.billingModel,
        rateCardId: contract.data.rateCardId ?? '',
      });
    }
  }, [contract.data]);
  const matching = (cards.data ?? []).filter((card) => card.currency === draft.currency);
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Contract')}</CardTitle>
        <CardDescription>{t('What the client pays, in the project’s currency, and how its time is billed. The budget stays in {currency}.', { currency: contract.data?.reportingCurrency ?? '' })}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary isLoading={contract.isLoading} isError={contract.isError} error={contract.error} onRetry={() => void contract.refetch()} errorTitle={t('The contract could not be loaded')} skeleton={<ListSkeleton rows={2} />}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contract-currency">{t('Currency')}</Label>
              <Select value={draft.currency} disabled={!manage} onValueChange={(currency) => setDraft({ ...draft, currency, rateCardId: '' })}>
                <SelectTrigger id="contract-currency" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(currencies.data?.currencies ?? []).map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contract-value">{t('Contract value')}</Label>
              <Input id="contract-value" className="w-40" inputMode="decimal" disabled={!manage} value={draft.contractValue} onChange={(event) => setDraft({ ...draft, contractValue: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contract-model">{t('Billing')}</Label>
              <Select value={draft.billingModel} disabled={!manage} onValueChange={(value) => setDraft({ ...draft, billingModel: value as BillingModel })}>
                <SelectTrigger id="contract-model" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODEL_LABEL) as BillingModel[]).map((model) => (
                    <SelectItem key={model} value={model}>
                      {MODEL_LABEL[model]()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contract-card">{t('Rate card')}</Label>
              <Select value={draft.rateCardId || 'default'} disabled={!manage} onValueChange={(value) => setDraft({ ...draft, rateCardId: value === 'default' ? '' : value })}>
                <SelectTrigger id="contract-card" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('The default card in {currency}', { currency: draft.currency })}</SelectItem>
                  {matching.map((card) => (
                    <SelectItem key={card.id} value={card.id}>
                      {card.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {manage ? (
              <Button
                size="sm"
                loading={save.isPending}
                onClick={() =>
                  save.mutate(
                    {
                      projectId,
                      input: {
                        currency: draft.currency,
                        contractValue: draft.contractValue.trim() ? Number(draft.contractValue) : null,
                        billingModel: draft.billingModel,
                        rateCardId: draft.rateCardId || null,
                      },
                    },
                    {
                      onSuccess: () => toast.success(t('Contract saved')),
                      onError: (error) => toast.error(t('The contract was not saved'), { description: errorText(error) }),
                    },
                  )
                }
              >
                {t('Save')}
              </Button>
            ) : null}
          </div>
          {contract.data && !contract.data.rateCardName && draft.billingModel === 'time_and_materials' ? (
            <p className="mt-3 text-2xs text-muted-foreground">{t('No rate card applies, so no time is billed: add one in {currency} under Administration.', { currency: draft.currency })}</p>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function PhasingCard({ projectId, manage }: { projectId: ID; manage: boolean }) {
  const phasing = usePhasing(projectId);
  const save = useSavePhasing();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (phasing.data) setAmounts(Object.fromEntries(phasing.data.phases.map((phase) => [phase.month, String(phase.amount)])));
  }, [phasing.data]);
  const total = useMemo(() => Object.values(amounts).reduce((sum, value) => sum + Math.round((Number(value) || 0) * 100), 0) / 100, [amounts]);
  const basis = phasing.data?.basis;
  const basisText =
    basis === 'manual'
      ? phasing.data!.rescaled
        ? t('Set by hand, scaled to the budget changed since.')
        : t('Set by hand.')
      : basis === 'schedule'
        ? t('From the schedule: the priced work planned in each month.')
        : basis === 'dates'
          ? t('Over the working days of the planned dates.')
          : basis === 'single'
            ? t('All in one month: the project has no planned dates or priced work.')
            : t('The project has no budget to phase.');
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Budget phasing')}</CardTitle>
        <CardDescription>{basisText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <QueryBoundary isLoading={phasing.isLoading} isError={phasing.isError} error={phasing.error} onRetry={() => void phasing.refetch()} errorTitle={t('The phasing could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          {phasing.data && phasing.data.budget !== null ? (
            <>
              <div className="flex flex-wrap gap-2">
                {phasing.data.phases.map((phase) => (
                  <div key={phase.month} className="space-y-1.5">
                    <Label htmlFor={`phase-${phase.month}`} className="text-2xs">
                      {monthLabel(phase.month)}
                    </Label>
                    <Input
                      id={`phase-${phase.month}`}
                      className="w-32"
                      inputMode="decimal"
                      disabled={!manage}
                      value={amounts[phase.month] ?? ''}
                      onChange={(event) => setAmounts({ ...amounts, [phase.month]: event.target.value })}
                    />
                  </div>
                ))}
              </div>
              <p className="text-2xs text-muted-foreground">
                {t('{total} of the budget of {budget}', { total: money(total), budget: money(phasing.data.budget) })}
              </p>
              {manage ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={save.isPending}
                    disabled={Math.round(total * 100) !== Math.round(phasing.data.budget * 100)}
                    onClick={() =>
                      save.mutate(
                        { projectId, phases: Object.entries(amounts).map(([month, value]) => ({ month, amount: Number(value) || 0 })) },
                        {
                          onSuccess: () => toast.success(t('Phasing saved')),
                          onError: (error) => toast.error(t('The phasing was not saved'), { description: errorText(error) }),
                        },
                      )
                    }
                  >
                    {t('Save')}
                  </Button>
                  {basis === 'manual' ? (
                    <Button size="sm" variant="outline" onClick={() => save.mutate({ projectId, phases: null })}>
                      {t('Phase from the schedule again')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function BillingCard({ projectId, manage }: { projectId: ID; manage: boolean }) {
  const today = toISODateOnly(new Date());
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const billing = useBilling(projectId, from, to);
  const generate = useGenerateBilling();
  const view = billing.data;
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Billable items')}</CardTitle>
        <CardDescription>{t('Made from approved time, approved expense claims and milestones reached, by the project’s billing, in its currency.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="billing-from">{t('From')}</Label>
            <Input id="billing-from" type="date" className="w-40" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="billing-to">{t('To')}</Label>
            <Input id="billing-to" type="date" className="w-40" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          {manage ? (
            <Button
              size="sm"
              loading={generate.isPending}
              onClick={() =>
                generate.mutate(
                  { projectId, from, to },
                  {
                    onSuccess: () => toast.success(t('Billable items made')),
                    onError: (error) => toast.error(t('The billable items were not made'), { description: errorText(error) }),
                  },
                )
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('Make billable items')}
            </Button>
          ) : null}
        </div>
        <QueryBoundary isLoading={billing.isLoading} isError={billing.isError} error={billing.error} onRetry={() => void billing.refetch()} errorTitle={t('The billable items could not be loaded')} skeleton={<ListSkeleton rows={4} />}>
          {view ? (
            <>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-2xs text-muted-foreground">
                    <th className="py-1.5 text-start font-medium">{t('Date')}</th>
                    <th className="py-1.5 text-start font-medium">{t('Item')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Quantity')}</th>
                    <th className="py-1.5 text-end font-medium">{t('Amount')}</th>
                    <th className="py-1.5 text-start font-medium">{t('Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((item) => (
                    <tr key={item.id} className="border-b border-border/60">
                      <td className="py-1.5">{formatShortDate(item.day)}</td>
                      <td className="py-1.5" dir="auto">
                        {item.description}
                      </td>
                      <td className="py-1.5 text-end font-mono">{formatNumber(item.quantity)}</td>
                      <td className="py-1.5 text-end font-mono">
                        {money(item.amount)} {item.currency}
                      </td>
                      <td className="py-1.5">{item.status === 'open' ? t('Open') : item.status === 'batched' ? t('In a batch') : t('Transferred')}</td>
                    </tr>
                  ))}
                  {view.items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-3 text-2xs text-muted-foreground">
                        {t('No billable items in this period.')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <p className="text-2xs text-muted-foreground">
                {view.reconciliation.reconciles
                  ? t('Reconciles: {hours} approved hours and {expenses} of approved expenses are billed.', {
                      hours: formatNumber(view.reconciliation.hours.approved),
                      expenses: money(view.reconciliation.expenses.approved),
                    })
                  : t('Does not reconcile: {billedHours} of {hours} approved hours and {billedExpenses} of {expenses} of approved expenses are billed.', {
                      billedHours: formatNumber(view.reconciliation.hours.billed),
                      hours: formatNumber(view.reconciliation.hours.approved),
                      billedExpenses: money(view.reconciliation.expenses.billed),
                      expenses: money(view.reconciliation.expenses.approved),
                    })}
              </p>
            </>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function BatchesCard({ projectId, manage }: { projectId?: ID; manage: boolean }) {
  const batches = useBatches();
  const create = useCreateBatch();
  const send = useSendBatch();
  const download = async (id: ID) => {
    try {
      saveBlob(await downloadBatch(id), `epm-billing-${id.slice(0, 8)}.xlsx`);
    } catch (error) {
      toast.error(t('The download failed'), { description: errorText(error) });
    }
  };
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Transfers to finance')}</CardTitle>
        <CardDescription>{t('Open billable items are sent in batches. Each batch and item keeps its id when sent again, so nothing is taken twice; each answer is reconciled.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {manage ? (
          <Button
            size="sm"
            loading={create.isPending}
            onClick={() =>
              create.mutate(projectId, {
                onSuccess: () => toast.success(t('Batch made')),
                onError: (error) => toast.error(t('No batch was made'), { description: errorText(error) }),
              })
            }
          >
            {projectId ? t('Batch this project’s open items') : t('Batch every open item')}
          </Button>
        ) : null}
        <QueryBoundary isLoading={batches.isLoading} isError={batches.isError} error={batches.error} onRetry={() => void batches.refetch()} errorTitle={t('The batches could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Batch')}</th>
                <th className="py-1.5 text-start font-medium">{t('Made')}</th>
                <th className="py-1.5 text-end font-medium">{t('Items')}</th>
                <th className="py-1.5 text-end font-medium">{t('Totals')}</th>
                <th className="py-1.5 text-start font-medium">{t('Status')}</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {(batches.data ?? []).map((batch) => (
                <tr key={batch.id} className="border-b border-border/60">
                  <td className="py-1.5 font-mono">{batch.id.slice(0, 8)}</td>
                  <td className="py-1.5">{formatShortDate(batch.createdAt)}</td>
                  <td className="py-1.5 text-end">{batch.itemCount}</td>
                  <td className="py-1.5 text-end font-mono">
                    {Object.entries(batch.totals)
                      .map(([currency, amount]) => `${money(amount)} ${currency}`)
                      .join(', ')}
                  </td>
                  <td className="py-1.5">
                    <Badge tone={batch.status === 'acknowledged' ? 'success' : batch.status === 'ready' ? 'neutral' : 'danger'}>{BATCH_LABEL[batch.status]()}</Badge>
                    {batch.lastError ? <span className="ms-2 text-2xs text-muted-foreground">{batch.lastError}</span> : null}
                  </td>
                  <td className="py-1.5 text-end">
                    <div className="flex justify-end gap-1">
                      {manage && batch.status !== 'acknowledged' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={send.isPending}
                          onClick={() =>
                            send.mutate(
                              { id: batch.id, replay: batch.status !== 'ready' && batch.status !== 'failed' },
                              { onError: (error) => toast.error(t('The batch was not sent'), { description: errorText(error) }) },
                            )
                          }
                        >
                          <Send className="h-3.5 w-3.5" />
                          {batch.status === 'ready' || batch.status === 'failed' ? t('Send') : t('Send again')}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" aria-label={t('Download')} onClick={() => void download(batch.id)}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {(batches.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-2xs text-muted-foreground">
                    {t('No batches yet.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
