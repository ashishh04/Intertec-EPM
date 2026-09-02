import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Gauge } from 'lucide-react';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { SectionHeader } from '@/components/common/PageHeader';
import {
  DeliveryTrendChart,
  StatusDistributionChart,
  HorizontalBarChart,
} from '@/components/charts/EpmCharts';
import { useDeliveryTrends, useStatusDistribution } from '@/hooks/useReports';
import { useTasks } from '@/hooks/useTasks';
import { useUsers } from '@/hooks/useUsers';
import { daysFromToday, formatHours } from '@/lib/utils';

/** Project-scoped delivery reporting. */
export default function ProjectReportsTab() {
  const { projectId } = useParams();
  const distributionQuery = useStatusDistribution({ projectId });
  const trendsQuery = useDeliveryTrends({ projectId });
  const tasksQuery = useTasks({ projectId, pageSize: 200 });
  const { data: users } = useUsers();

  const tasks = useMemo(() => tasksQuery.data?.items ?? [], [tasksQuery.data]);

  const stats = useMemo(() => {
    const open = tasks.filter((task) => task.statusCategory !== 'done');
    const overdue = open.filter((task) => (daysFromToday(task.dueDate) ?? 0) < 0);
    const spent = tasks.reduce((sum, task) => sum + (task.spentHours ?? 0), 0);
    const estimated = tasks.reduce((sum, task) => sum + (task.estimatedHours ?? 0), 0);

    return {
      completed: tasks.length - open.length,
      open: open.length,
      overdue: overdue.length,
      spent,
      estimated,
    };
  }, [tasks]);

  // Assigned open work per person, for a quick load comparison.
  const byAssignee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.statusCategory === 'done' || !task.assigneeId) continue;
      counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([userId, value]) => ({
        label: users?.find((user) => user.id === userId)?.name.split(' ')[0] ?? 'Unknown',
        value,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [tasks, users]);

  const isLoading = tasksQuery.isLoading || distributionQuery.isLoading;

  return (
    <div className="space-y-5">
      <SectionHeader title="Project reporting" description="Progress, distribution and effort" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading ? (
          [0, 1, 2, 3].map((index) => <MetricCardSkeleton key={index} />)
        ) : (
          <>
            <MetricCard
              label="Completed"
              value={stats.completed}
              support={`of ${tasks.length} work packages`}
              icon={CheckCircle2}
              tone="success"
            />
            <MetricCard label="Open" value={stats.open} support="Still in flight" icon={Gauge} tone="primary" />
            <MetricCard
              label="Overdue"
              value={stats.overdue}
              support="Past the committed date"
              icon={AlertTriangle}
              tone="danger"
            />
            <MetricCard
              label="Effort logged"
              value={formatHours(stats.spent)}
              support={`${formatHours(stats.estimated)} estimated`}
              icon={Clock}
              tone="accent"
            />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {distributionQuery.isLoading ? (
          <ChartCardSkeleton />
        ) : (
          <ChartCard title="Status distribution" description="Where work currently sits">
            <StatusDistributionChart data={distributionQuery.data ?? []} />
          </ChartCard>
        )}

        {tasksQuery.isLoading ? (
          <ChartCardSkeleton />
        ) : (
          <ChartCard title="Open work by assignee" description="Active load across the project team">
            <HorizontalBarChart data={byAssignee} tone="accent" />
          </ChartCard>
        )}
      </div>

      {trendsQuery.isLoading ? (
        <ChartCardSkeleton height={260} />
      ) : (
        <ChartCard
          title="Delivery trend"
          description="Completed vs. created work packages per sprint"
          height={260}
        >
          <DeliveryTrendChart data={trendsQuery.data ?? []} />
        </ChartCard>
      )}
    </div>
  );
}
