import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useCaptureScenario, useScenarios } from '@/hooks/useScenarios';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import type { ScenarioStatus } from '@/types';

export const SCENARIO_STATUS: Record<ScenarioStatus, { label: () => string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: () => t('Draft'), tone: 'neutral' },
  submitted: { label: () => t('Awaiting approval'), tone: 'warning' },
  promoted: { label: () => t('Applied'), tone: 'success' },
  rejected: { label: () => t('Rejected'), tone: 'danger' },
};

/**
 * Portfolio scenarios (BR-220 to BR-222): copies of a portfolio's projects and
 * open work, adjusted and compared without touching live data, and applied to
 * it only once approved.
 */
export default function ScenariosPage() {
  const scenarios = useScenarios();
  const portfolios = usePortfolios();
  const capture = useCaptureScenario();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [portfolioId, setPortfolioId] = useState('');

  return (
    <div className="space-y-5">
      <PageHeader title={t('Scenarios')} description={t('Copy a portfolio as it stands, try changes without touching live data, compare, and apply the one chosen once it is approved.')} />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="scenario-name">{t('Name')}</Label>
            <Input id="scenario-name" className="w-64" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('e.g. Defer phase 2')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scenario-portfolio">{t('Portfolio')}</Label>
            <Select value={portfolioId} onValueChange={setPortfolioId}>
              <SelectTrigger id="scenario-portfolio" className="w-64">
                <SelectValue placeholder={t('Choose a portfolio')} />
              </SelectTrigger>
              <SelectContent>
                {(portfolios.data ?? []).map((portfolio) => (
                  <SelectItem key={portfolio.id} value={portfolio.id}>
                    {portfolio.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={!name.trim() || !portfolioId}
            loading={capture.isPending}
            onClick={() =>
              capture.mutate(
                { name: name.trim(), portfolioId },
                {
                  onSuccess: (scenario) => navigate(`/scenarios/${scenario.id}`),
                  onError: (error) => toast.error(t('The scenario was not made'), { description: error instanceof Error ? error.message : undefined }),
                },
              )
            }
          >
            <Plus className="h-4 w-4" />
            {t('Make a scenario')}
          </Button>
        </CardContent>
      </Card>
      <QueryBoundary isLoading={scenarios.isLoading} isError={scenarios.isError} error={scenarios.error} onRetry={() => void scenarios.refetch()} errorTitle={t('The scenarios could not be loaded')} skeleton={<ListSkeleton rows={4} />}>
        <Card>
          <CardContent className="pt-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="py-1.5 text-start font-medium">{t('Scenario')}</th>
                  <th className="py-1.5 text-start font-medium">{t('Made')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Projects')}</th>
                  <th className="py-1.5 text-start font-medium">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {(scenarios.data ?? []).map((scenario) => (
                  <tr key={scenario.id} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      <Link className="text-primary hover:underline" to={`/scenarios/${scenario.id}`}>
                        {scenario.name}
                      </Link>
                    </td>
                    <td className="py-1.5">{formatDateTime(scenario.capturedAt)}</td>
                    <td className="py-1.5 text-end">{scenario.projects}</td>
                    <td className="py-1.5">
                      <Badge tone={SCENARIO_STATUS[scenario.status].tone}>{SCENARIO_STATUS[scenario.status].label()}</Badge>
                    </td>
                  </tr>
                ))}
                {(scenarios.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-2xs text-muted-foreground">
                      {t('No scenarios yet.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </QueryBoundary>
    </div>
  );
}
