import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/services/api/client';
import { saveBlob } from '@/lib/download';
import { GanttChart, GanttChartSkeleton } from '@/components/gantt/GanttChart';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { SectionHeader } from '@/components/common/PageHeader';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import { useProjectCriticalPath } from '@/hooks/useSchedule';
import { useTaskTimeline } from '@/hooks/useTasks';
import { useProjectMilestones } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';

/** Schedule view for a single project. */
export default function ProjectGanttTab() {
  const { projectId } = useParams();
  // A timeline is read as a whole, so it loads every page; the notice under
  // it says when it stops short.
  const tasksQuery = useTaskTimeline(projectId);
  const criticalPath = useProjectCriticalPath(projectId);
  const milestonesQuery = useProjectMilestones(projectId);
  const users = useUserMap();
  const tasks = tasksQuery.data?.items ?? [];
  const total = tasksQuery.data?.total ?? tasks.length;

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t('Timeline')}
        description={t('Scheduled work packages, dependencies, milestones and the critical path')}
        actions={projectId ? <GanttPdfButton projectId={projectId} /> : null}
      />
      <QueryBoundary
        isLoading={tasksQuery.isLoading}
        isError={tasksQuery.isError}
        error={tasksQuery.error}
        onRetry={() => tasksQuery.refetch()}
        errorTitle={t('Unable to load the timeline')}
        skeleton={<GanttChartSkeleton />}
      >
        <div className="space-y-3">
          <GanttChart
            tasks={tasks}
            users={users}
            milestones={milestonesQuery.data ?? []}
            schedule={criticalPath.data}
          />
          <TruncationNotice shown={tasks.length} total={total} affected={t('The bars')} />
        </div>
      </QueryBoundary>
    </div>
  );
}

/** The project's schedule as a PDF, in the reader's language. */
function GanttPdfButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const exportPdf = async () => {
    setBusy(true);
    try {
      const blob = await apiClient.download(`/projects/${projectId}/gantt.pdf`, undefined, 120_000);
      saveBlob(blob, `gantt-${projectId}-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (error) {
      toast.error(t('The PDF could not be made'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" loading={busy} onClick={() => void exportPdf()}>
      <FileDown className="h-3.5 w-3.5" />
      {t('Export PDF')}
    </Button>
  );
}
