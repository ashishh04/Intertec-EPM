import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Plus, Receipt } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ClaimDialog } from '@/components/expenses/ClaimDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useClaims } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { formatNumber, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { expenseService } from '@/services';
import type { ExpenseClaimStatus, ExpenseClaimView } from '@/types';

export const CLAIM_STATUS: Record<ExpenseClaimStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'highlight' }> = {
  draft: { get label() { return t('Draft'); }, tone: 'neutral' },
  submitted: { get label() { return t('Submitted'); }, tone: 'primary' },
  approved: { get label() { return t('Approved, not yet posted'); }, tone: 'highlight' },
  posted: { get label() { return t('Posted to the project'); }, tone: 'success' },
};

const claimKey = (id: string) => `EX-${id.slice(-6).toUpperCase()}`;

/**
 * Expense claims (BR-307 to BR-309): your own — drafted, submitted, approved,
 * posted to the project as an OpenProject cost entry — and, for whoever
 * manages claims, everyone's, with the export for finance.
 */
export default function ExpensesPage() {
  const { can } = useAuth();
  const manage = can('expenses:manage');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'all' && manage ? 'all' : 'mine';
  const [creating, setCreating] = useState(false);
  const mine = useClaims({ scope: 'mine' }, tab === 'mine');
  const firstOfMonth = `${toISODateOnly(new Date()).slice(0, 7)}-01`;
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(toISODateOnly(new Date()));
  const all = useClaims({ scope: 'all', from, to }, tab === 'all');
  const [exporting, setExporting] = useState(false);

  const exportPeriod = async () => {
    setExporting(true);
    try {
      const blob = await expenseService.exportPeriod(from, to);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `expense-claims-${from}-to-${to}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(t('The export failed'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Expense claims')}
        description={t('Costs paid for a project, approved and then recorded against it.')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            {t('New claim')}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList variant="underline">
          <TabsTrigger value="mine" variant="underline">
            {t('My claims')}
          </TabsTrigger>
          {manage ? (
            <TabsTrigger value="all" variant="underline">
              {t('Everyone’s')}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="mine" className="mt-4">
          <QueryBoundary
            isLoading={mine.isLoading}
            isError={mine.isError}
            error={mine.error}
            onRetry={() => void mine.refetch()}
            errorTitle={t('Your claims could not be loaded')}
            skeleton={<ListSkeleton rows={5} />}
          >
            {(mine.data ?? []).length === 0 ? (
              <Card>
                <EmptyState
                  icon={Receipt}
                  title={t('No claims yet')}
                  description={t('Claim a cost you paid for a project: it goes for approval and is then recorded against the project.')}
                  action={{ label: t('New claim'), onClick: () => setCreating(true) }}
                />
              </Card>
            ) : (
              <ClaimTable claims={mine.data ?? []} />
            )}
          </QueryBoundary>
        </TabsContent>
        <TabsContent value="all" className="mt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="claims-from">{t('Paid from')}</Label>
              <Input id="claims-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="claims-to">{t('to')}</Label>
              <Input id="claims-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="w-40" />
            </div>
            <Button variant="secondary" loading={exporting} onClick={() => void exportPeriod()}>
              <Download className="h-4 w-4" />
              {t('Export for finance')}
            </Button>
          </div>
          <QueryBoundary
            isLoading={all.isLoading}
            isError={all.isError}
            error={all.error}
            onRetry={() => void all.refetch()}
            errorTitle={t('The claims could not be loaded')}
            skeleton={<ListSkeleton rows={6} />}
          >
            <ClaimTable claims={all.data ?? []} showClaimant />
          </QueryBoundary>
        </TabsContent>
      </Tabs>
      <ClaimDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function ClaimTable({ claims, showClaimant = false }: { claims: ExpenseClaimView[]; showClaimant?: boolean }) {
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-2xs text-muted-foreground">
              <th className="px-4 py-2 text-start font-medium">{t('Claim')}</th>
              <th className="px-4 py-2 text-start font-medium">{t('Paid on')}</th>
              {showClaimant ? <th className="px-4 py-2 text-start font-medium">{t('Claimant')}</th> : null}
              <th className="px-4 py-2 text-start font-medium">{t('Project')}</th>
              <th className="px-4 py-2 text-start font-medium">{t('Category')}</th>
              <th className="px-4 py-2 text-end font-medium">{t('Amount')}</th>
              <th className="px-4 py-2 text-start font-medium">{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((claim) => (
              <tr key={claim.id} className="border-b border-border/60">
                <td className="px-4 py-2">
                  <Link to={`/expenses/${claim.id}`} className="font-mono hover:text-primary">
                    {claimKey(claim.id)}
                  </Link>
                </td>
                <td className="px-4 py-2">{formatShortDate(claim.spentOn)}</td>
                {showClaimant ? (
                  <td className="px-4 py-2" dir="auto">
                    {claim.claimantName}
                  </td>
                ) : null}
                <td className="px-4 py-2" dir="auto">
                  {claim.projectName}
                </td>
                <td className="px-4 py-2" dir="auto">
                  {claim.categoryName}
                </td>
                <td className="px-4 py-2 text-end font-mono">
                  {formatNumber(claim.amount)} {claim.currency}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={claim.rejection ? 'danger' : CLAIM_STATUS[claim.status].tone}>
                    {claim.rejection ? t('Rejected') : CLAIM_STATUS[claim.status].label}
                  </Badge>
                </td>
              </tr>
            ))}
            {claims.length === 0 ? (
              <tr>
                <td colSpan={showClaimant ? 7 : 6} className="px-4 py-4 text-2xs text-muted-foreground">
                  {t('No claims in this period.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
