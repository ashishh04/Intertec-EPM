import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEvmSettings, useSaveEvmSettings } from '@/hooks/useEarnedValue';
import { useUserMap } from '@/hooks/useUsers';
import { formatDateTime } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { EarningMethod, EvmSettings } from '@/types';
import { describeError } from './shared-format';

/**
 * How work earns value (BR-302): a rule for each work package type, the rule
 * for every type not given one, and the rate that prices work whose assignee
 * has none. Policy for every project's earned value, so it needs
 * `evm:configure`; each save is a new version, journalled, and a figure for a
 * past date keeps the rules that were in force then.
 */

const DEFAULT = '__default__';

type Draft = Pick<EvmSettings, 'defaultMethod' | 'methods' | 'unpricedRate'>;

const toDraft = (settings: EvmSettings): Draft => ({
  defaultMethod: settings.defaultMethod,
  methods: { ...settings.methods },
  unpricedRate: settings.unpricedRate,
});

const same = (a: Draft, b: Draft) =>
  a.defaultMethod === b.defaultMethod &&
  a.unpricedRate === b.unpricedRate &&
  JSON.stringify(Object.entries(a.methods).sort()) === JSON.stringify(Object.entries(b.methods).sort());

export default function EarnedValuePage() {
  const { can } = useAuth();
  const mayConfigure = can('evm:configure');
  const view = useEvmSettings();
  const save = useSaveEvmSettings();
  const users = useUserMap();
  const [draft, setDraft] = useState<Draft>();
  const [rate, setRate] = useState('');

  useEffect(() => {
    if (!view.data) return;
    setDraft(toDraft(view.data.settings));
    setRate(view.data.settings.unpricedRate === null ? '' : String(view.data.settings.unpricedRate));
  }, [view.data]);

  const labelOf = useMemo(
    () => new Map((view.data?.methods ?? []).map((method) => [method.id, method.label])),
    [view.data],
  );
  const parsedRate = rate.trim() === '' ? null : Number(rate);
  const rateProblem = parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0) ? 'A rate is a number, nought or more.' : null;
  const current = draft ? { ...draft, unpricedRate: rateProblem ? draft.unpricedRate : parsedRate } : undefined;
  const dirty = Boolean(current && view.data && !same(current, toDraft(view.data.settings)));
  const settings = view.data?.settings;

  const submit = () => {
    if (!current || rateProblem) return;
    save.mutate(current, {
      onSuccess: (saved) => toast.success(`Earned value rules version ${saved.version} saved`, { description: 'Every project’s figures from now on use them.' }),
      onError: (error) => toast.error('The rules were not saved', { description: describeError(error) }),
    });
  };

  return (
    <div className="space-y-4">
      {!mayConfigure ? (
        <Alert tone="neutral" title="Read only">
          Changing how work earns value needs the earned value configuration permission (evm:configure).
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={view.isLoading}
        isError={view.isError}
        error={view.error}
        onRetry={() => void view.refetch()}
        errorTitle="The earned value rules could not be loaded"
        skeleton={<ListSkeleton rows={6} height="h-10" />}
      >
        {view.data && draft ? (
          <>
            <Card>
              <CardHeader variant="compact">
                <CardTitle>How each type of work earns value</CardTitle>
                <CardDescription>
                  Earned value is a work package’s budget times the share its rule credits it with. Delivered work has earned all
                  of it, whatever the rule.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <ul className="space-y-1.5 text-2xs text-muted-foreground">
                  {view.data.methods.map((method) => (
                    <li key={method.id}>
                      <span className="font-medium text-foreground">{method.label}</span> — {method.describe}
                    </li>
                  ))}
                </ul>

                <div className="space-y-1.5">
                  <Label htmlFor="evm-default">Every type not given a rule</Label>
                  <Select
                    value={draft.defaultMethod}
                    onValueChange={(value) => setDraft({ ...draft, defaultMethod: value as EarningMethod })}
                    disabled={!mayConfigure}
                  >
                    <SelectTrigger id="evm-default" className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {view.data.methods.map((method) => (
                        <SelectItem key={method.id} value={method.id}>
                          {method.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="divide-y divide-border rounded-md border border-border" data-testid="evm-type-rules">
                  {view.data.types.map((type) => (
                    <div key={type.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate text-xs text-foreground">
                        {type.name}
                        {type.isMilestone ? <span className="ms-1.5 text-2xs text-muted-foreground">(milestone)</span> : null}
                      </span>
                      <Select
                        value={draft.methods[type.id] ?? DEFAULT}
                        onValueChange={(value) => {
                          const methods = { ...draft.methods };
                          if (value === DEFAULT) delete methods[type.id];
                          else methods[type.id] = value as EarningMethod;
                          setDraft({ ...draft, methods });
                        }}
                        disabled={!mayConfigure}
                      >
                        <SelectTrigger className="h-8 w-64" aria-label={`How ${type.name} earns value`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT}>Default ({labelOf.get(draft.defaultMethod)})</SelectItem>
                          {view.data!.methods.map((method) => (
                            <SelectItem key={method.id} value={method.id}>
                              {method.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>Work with no rate</CardTitle>
                <CardDescription>
                  A work package’s budget is its estimated hours at its assignee’s hourly rate. Work whose assignee has no rate, or
                  that has no assignee, is priced at this rate — or, left empty, left out of the figures and counted.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-4">
                <Label htmlFor="evm-rate">Hourly rate for unpriced work</Label>
                <Input
                  id="evm-rate"
                  inputMode="decimal"
                  className="w-40"
                  value={rate}
                  placeholder="None"
                  disabled={!mayConfigure}
                  onChange={(event) => setRate(event.target.value)}
                />
                {rateProblem ? <FieldError>{rateProblem}</FieldError> : null}
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xs text-muted-foreground">
                {settings && settings.version > 0
                  ? `Version ${settings.version}, saved ${settings.updatedAt ? formatDateTime(settings.updatedAt) : ''} by ${
                      users.get(settings.updatedBy ?? '')?.name ?? 'someone'
                    }. A figure for a past date uses the rules in force then.`
                  : 'The defaults: every type earns by percent complete. Nothing has been saved yet.'}
              </p>
              {mayConfigure ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!dirty || save.isPending}
                    onClick={() => {
                      setDraft(toDraft(view.data!.settings));
                      setRate(view.data!.settings.unpricedRate === null ? '' : String(view.data!.settings.unpricedRate));
                    }}
                  >
                    Reset
                  </Button>
                  <Button size="sm" disabled={!dirty || Boolean(rateProblem)} loading={save.isPending} onClick={submit}>
                    Save
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </QueryBoundary>
    </div>
  );
}
