import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  useAddRate,
  useCurrencies,
  useDeleteRateCard,
  useExchangeRates,
  useFinanceSettings,
  useRateCards,
  useSaveFinanceSettings,
  useSaveRateCard,
} from '@/hooks/useFinance';
import { useResourceRoles } from '@/hooks/useResources';
import { t } from '@/lib/i18n';
import { formatNumber, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { FinanceSettings, ProjectStatusKey } from '@/types';
import { describeError } from './shared-format';

const STATUS_LABEL: Record<ProjectStatusKey, () => string> = {
  not_started: () => t('Not started'),
  on_track: () => t('On track'),
  at_risk: () => t('At risk'),
  off_track: () => t('Off track'),
  finished: () => t('Finished'),
  discontinued: () => t('Discontinued'),
  none: () => t('No status'),
};

/**
 * The finance rules (Module 11, part 2): exchange rates into the reporting
 * currency (BR-321), rate cards of bill rates by role (BR-318, BR-319), the
 * forecast's confidence by project status and its horizon, and the finance
 * system billable items are sent to (BR-323). Changing them needs
 * `finance:configure`; each change is journalled.
 */
export default function FinanceSettingsPage() {
  const { can } = useAuth();
  const configure = can('finance:configure');
  const readable = configure || can('finance:view');
  return (
    <div className="space-y-4">
      {!configure ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Changing the finance rules needs the finance rules permission.')}
        </Alert>
      ) : null}
      {readable ? (
        <>
          <RatesCard configure={configure} />
          <RateCardsCard configure={configure} />
          <ForecastCard configure={configure} />
        </>
      ) : null}
    </div>
  );
}

function RatesCard({ configure }: { configure: boolean }) {
  const rates = useExchangeRates();
  const currencies = useCurrencies();
  const add = useAddRate();
  const [draft, setDraft] = useState({ currency: '', rate: '', effectiveFrom: toISODateOnly(new Date()), kind: 'actual' as 'actual' | 'planning' });
  const reporting = currencies.data?.reporting ?? '';
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Exchange rates')}</CardTitle>
        <CardDescription>
          {t('What one unit of each currency is worth in {currency}, from the day it takes effect. Rates are never changed: a correction is a new rate, and what was already converted keeps its rate.', { currency: reporting })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <QueryBoundary isLoading={rates.isLoading} isError={rates.isError} error={rates.error} onRetry={() => void rates.refetch()} errorTitle={t('The exchange rates could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Currency')}</th>
                <th className="py-1.5 text-start font-medium">{t('From')}</th>
                <th className="py-1.5 text-start font-medium">{t('Kind')}</th>
                <th className="py-1.5 text-end font-medium">{t('Rate')}</th>
              </tr>
            </thead>
            <tbody>
              {(rates.data ?? []).map((rate) => (
                <tr key={rate.id} className="border-b border-border/60">
                  <td className="py-1.5 font-mono">{rate.currency}</td>
                  <td className="py-1.5">{formatShortDate(rate.effectiveFrom)}</td>
                  <td className="py-1.5">{rate.kind === 'planning' ? t('Planning') : t('Actual')}</td>
                  <td className="py-1.5 text-end font-mono">{formatNumber(rate.rate)}</td>
                </tr>
              ))}
              {(rates.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-2xs text-muted-foreground">
                    {t('No exchange rates yet: everything is in {currency}.', { currency: reporting })}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </QueryBoundary>
        {configure ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="rate-currency">{t('Currency')}</Label>
              <Input id="rate-currency" className="w-24 font-mono" maxLength={3} value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} placeholder="USD" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-value">{t('Worth in {currency}', { currency: reporting })}</Label>
              <Input id="rate-value" className="w-32" inputMode="decimal" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-from">{t('From')}</Label>
              <Input id="rate-from" type="date" className="w-40" value={draft.effectiveFrom} onChange={(event) => setDraft({ ...draft, effectiveFrom: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-kind">{t('Kind')}</Label>
              <Select value={draft.kind} onValueChange={(value) => setDraft({ ...draft, kind: value as 'actual' | 'planning' })}>
                <SelectTrigger id="rate-kind" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="actual">{t('Actual')}</SelectItem>
                  <SelectItem value="planning">{t('Planning')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={!/^[A-Z]{3}$/.test(draft.currency) || !(Number(draft.rate) > 0)}
              loading={add.isPending}
              onClick={() =>
                add.mutate(
                  { currency: draft.currency, rate: Number(draft.rate), effectiveFrom: draft.effectiveFrom, kind: draft.kind },
                  {
                    onSuccess: () => {
                      toast.success(t('Exchange rate added'));
                      setDraft({ ...draft, currency: '', rate: '' });
                    },
                    onError: (error) => toast.error(t('The exchange rate was not added'), { description: describeError(error) }),
                  },
                )
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Add')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RateCardsCard({ configure }: { configure: boolean }) {
  const cards = useRateCards();
  const roles = useResourceRoles();
  const currencies = useCurrencies();
  const save = useSaveRateCard();
  const remove = useDeleteRateCard();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [everyone, setEveryone] = useState('');
  const [byRole, setByRole] = useState<Record<string, string>>({});
  const chosen = currency || currencies.data?.reporting || '';
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Rate cards')}</CardTitle>
        <CardDescription>{t('Bill rates by resource role, in one currency. A project bills at the card it names, or at the default card in its currency.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <QueryBoundary isLoading={cards.isLoading} isError={cards.isError} error={cards.error} onRetry={() => void cards.refetch()} errorTitle={t('The rate cards could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          <div className="space-y-2">
            {(cards.data ?? []).map((card) => (
              <div key={card.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3 text-xs">
                <div className="space-y-1">
                  <div className="font-medium" dir="auto">
                    {card.name} · <span className="font-mono">{card.currency}</span>
                    {card.isDefault ? <span className="ms-2 text-2xs text-muted-foreground">{t('Default')}</span> : null}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {card.rates.map((rate) => `${rate.roleName ?? t('Everyone else')}: ${formatNumber(rate.hourlyRate)}`).join(' · ') || t('No rates')}
                    {' · '}
                    {t('{count, plural, one {# project} other {# projects}}', { count: card.projects })}
                  </div>
                </div>
                {configure ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('Remove')}
                    disabled={card.projects > 0}
                    onClick={() => remove.mutate(card.id, { onError: (error) => toast.error(t('The rate card was not removed'), { description: describeError(error) }) })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
            {(cards.data ?? []).length === 0 ? <p className="text-2xs text-muted-foreground">{t('No rate cards yet: no time is billed until there is one.')}</p> : null}
          </div>
        </QueryBoundary>
        {configure ? (
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="card-name">{t('Name')}</Label>
                <Input id="card-name" className="w-56" value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="card-currency">{t('Currency')}</Label>
                <Select value={chosen} onValueChange={setCurrency}>
                  <SelectTrigger id="card-currency" className="w-28">
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
                <Label htmlFor="card-everyone">{t('Everyone else, an hour')}</Label>
                <Input id="card-everyone" className="w-32" inputMode="decimal" value={everyone} onChange={(event) => setEveryone(event.target.value)} />
              </div>
              <label className="flex items-center gap-2 pb-2 text-xs">
                <Switch checked={isDefault} onCheckedChange={setIsDefault} />
                {t('The default card in its currency')}
              </label>
            </div>
            {(roles.data ?? []).length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {(roles.data ?? []).map((role) => (
                  <div key={role.id} className="space-y-1.5">
                    <Label htmlFor={`card-role-${role.id}`} className="text-2xs" dir="auto">
                      {role.name}
                    </Label>
                    <Input id={`card-role-${role.id}`} className="w-28" inputMode="decimal" value={byRole[role.id] ?? ''} onChange={(event) => setByRole({ ...byRole, [role.id]: event.target.value })} />
                  </div>
                ))}
              </div>
            ) : null}
            <Button
              size="sm"
              disabled={!name.trim() || !chosen}
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    input: {
                      name: name.trim(),
                      currency: chosen,
                      isDefault,
                      rates: [
                        ...(everyone.trim() ? [{ roleId: null, hourlyRate: Number(everyone) }] : []),
                        ...Object.entries(byRole)
                          .filter(([, value]) => value.trim())
                          .map(([roleId, value]) => ({ roleId, hourlyRate: Number(value) })),
                      ],
                    },
                  },
                  {
                    onSuccess: () => {
                      toast.success(t('Rate card saved'));
                      setName('');
                      setEveryone('');
                      setByRole({});
                    },
                    onError: (error) => toast.error(t('The rate card was not saved'), { description: describeError(error) }),
                  },
                )
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Add rate card')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ForecastCard({ configure }: { configure: boolean }) {
  const settings = useFinanceSettings();
  const save = useSaveFinanceSettings();
  const [draft, setDraft] = useState<Pick<FinanceSettings, 'confidence' | 'horizonMonths' | 'endpoint'> | null>(null);
  useEffect(() => {
    if (settings.data) setDraft({ confidence: settings.data.confidence, horizonMonths: settings.data.horizonMonths, endpoint: settings.data.endpoint });
  }, [settings.data]);
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Forecast and finance system')}</CardTitle>
        <CardDescription>{t('How sure the revenue forecast is of a project, by its status; how far ahead it looks; and where billable items are sent.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <QueryBoundary isLoading={settings.isLoading || !draft} isError={settings.isError} error={settings.error} onRetry={() => void settings.refetch()} errorTitle={t('The finance settings could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          {draft ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                {(Object.keys(STATUS_LABEL) as ProjectStatusKey[]).map((key) => (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`confidence-${key}`} className="text-2xs">
                      {STATUS_LABEL[key]()}
                    </Label>
                    <Input
                      id={`confidence-${key}`}
                      className="w-20"
                      inputMode="numeric"
                      disabled={!configure}
                      value={String(draft.confidence[key])}
                      onChange={(event) => setDraft({ ...draft, confidence: { ...draft.confidence, [key]: Number(event.target.value) || 0 } })}
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="horizon">{t('Months ahead')}</Label>
                  <Input id="horizon" className="w-24" inputMode="numeric" disabled={!configure} value={String(draft.horizonMonths)} onChange={(event) => setDraft({ ...draft, horizonMonths: Number(event.target.value) || 1 })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="endpoint">{t('Finance system address')}</Label>
                  <Input id="endpoint" className="w-96" dir="ltr" disabled={!configure} placeholder="https://" value={draft.endpoint ?? ''} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value || null })} />
                </div>
                {configure ? (
                  <Button
                    size="sm"
                    loading={save.isPending}
                    onClick={() =>
                      save.mutate(draft, {
                        onSuccess: () => toast.success(t('Finance settings saved')),
                        onError: (error) => toast.error(t('The finance settings were not saved'), { description: describeError(error) }),
                      })
                    }
                  >
                    {t('Save')}
                  </Button>
                ) : null}
              </div>
              <p className="text-2xs text-muted-foreground">
                {t('Without an address, batches are downloaded and imported by hand. Each batch is sent under its own id, so the finance system can recognise one sent again.')}
              </p>
            </div>
          ) : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
