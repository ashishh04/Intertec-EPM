import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

import { DashboardBody } from '@/components/insights/DashboardBody';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { t } from '@/lib/i18n';
import type { DashboardId } from '@/types';

/** The dashboards that read well for one project, in the order a manager reaches for them. */
const DASHBOARDS: { id: DashboardId; label: () => string }[] = [
  { id: 'manager', label: () => t('Manager dashboard') },
  { id: 'delivery', label: () => t('Delivery') },
  { id: 'budget', label: () => t('Budget') },
  { id: 'earned-value', label: () => t('Earned value') },
  { id: 'risk', label: () => t('Risk exposure') },
  { id: 'utilisation', label: () => t('Utilisation') },
];

const PERIODS = [
  { id: '4', label: () => t('Last 4 weeks'), days: 28 },
  { id: '12', label: () => t('Last 12 weeks'), days: 84 },
  { id: '26', label: () => t('Last 6 months'), days: 182 },
  { id: '52', label: () => t('Last 12 months'), days: 365 },
];

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * A project's own dashboard: any of the organisation's dashboards, scoped to
 * this project, with the same figures, definitions and drill-through as on
 * the Dashboards page. The choice of dashboard and period is remembered.
 */
export default function ProjectDashboardTab() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [storedId, setDashboardId] = useLocalStorage<string>('epm.project.dashboard', 'manager');
  const [periodId, setPeriodId] = useLocalStorage<string>('epm.project.dashboard.period', '12');
  const dashboardId = (DASHBOARDS.some((entry) => entry.id === storedId) ? storedId : 'manager') as DashboardId;
  const period = PERIODS.find((entry) => entry.id === periodId) ?? PERIODS[1]!;

  const query = useMemo(() => {
    const to = isoDay(new Date());
    const from = isoDay(new Date(Date.now() - (period.days - 1) * 86_400_000));
    return { scope: `project:${projectId}`, from, to };
  }, [projectId, period.days]);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1">
          <Label htmlFor="project-dashboard">{t('Dashboard')}</Label>
          <Select value={dashboardId} onValueChange={setDashboardId}>
            <SelectTrigger id="project-dashboard" className="h-8 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DASHBOARDS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-dashboard-period">{t('Period')}</Label>
          <Select value={period.id} onValueChange={setPeriodId}>
            <SelectTrigger id="project-dashboard-period" className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button asChild variant="ghost" size="sm" className="ms-auto">
          <Link to={`/insights/${dashboardId}?scope=project:${projectId}&from=${query.from}`}>
            {t('Open in Dashboards')}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </Card>

      <DashboardBody
        dashboardId={dashboardId}
        query={query}
        // A row that leads elsewhere (a person, a team) opens that scope on the Dashboards page.
        onScope={(kind, id) => navigate(`/insights/${dashboardId}?scope=${kind}:${id}&from=${query.from}`)}
      />
    </div>
  );
}
