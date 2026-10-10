import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateExpenseCategory, useExpenseCategories, useTimeSettings } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { describeError } from './shared-format';

/**
 * Cost types: OpenProject's categories of non-labour cost, which expense
 * claims are made under (BR-307) and which an approved claim's cost entry is
 * recorded as (BR-309). Listed from OpenProject; one added here is a cost type
 * in the currency, at 1, so a claim's units are its amount.
 */
export default function CostTypesPage() {
  const { can } = useAuth();
  const allowed = can('time:configure') || can('expenses:manage');
  const categories = useExpenseCategories();
  const settings = useTimeSettings();
  const create = useCreateExpenseCategory();
  const [name, setName] = useState('');
  const currency = settings.data?.settings.expenses.currency ?? '';

  return (
    <div className="space-y-4">
      {!allowed ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Adding a cost type needs the time and expense rules or the expense claims permission.')}
        </Alert>
      ) : null}
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Cost types')}</CardTitle>
          <CardDescription>{t('OpenProject’s categories of cost other than labour. Expense claims are made under them, and recorded as them once approved.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <QueryBoundary
            isLoading={categories.isLoading}
            isError={categories.isError}
            error={categories.error}
            onRetry={() => void categories.refetch()}
            errorTitle={t('The cost types could not be loaded')}
            skeleton={<ListSkeleton rows={4} />}
          >
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="py-1.5 text-start font-medium">{t('Name')}</th>
                  <th className="py-1.5 text-start font-medium">{t('Unit')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Rate today')}</th>
                </tr>
              </thead>
              <tbody>
                {(categories.data ?? []).map((category) => (
                  <tr key={category.id} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      {category.name}
                    </td>
                    <td className="py-1.5">{category.isAmount ? t('An amount in {currency}', { currency: category.unit }) : category.unitPlural}</td>
                    <td className="py-1.5 text-end font-mono">{category.rate === null ? '—' : formatNumber(category.rate)}</td>
                  </tr>
                ))}
                {(categories.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-3 text-2xs text-muted-foreground">
                      {t('No cost types yet.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </QueryBoundary>
          {allowed ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <div className="space-y-1.5">
                <Label htmlFor="cost-type-name">{t('A category to claim under, in {currency}', { currency })}</Label>
                <Input id="cost-type-name" className="w-72" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('e.g. Travel')} />
              </div>
              <Button
                size="sm"
                disabled={!name.trim()}
                loading={create.isPending}
                onClick={() =>
                  create.mutate(name.trim(), {
                    onSuccess: () => {
                      toast.success(t('Cost type added'));
                      setName('');
                    },
                    onError: (error) => toast.error(t('The cost type was not added'), { description: describeError(error) }),
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Add')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
