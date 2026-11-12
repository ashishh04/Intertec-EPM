import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

import { BoardWorkspace } from '@/components/board/BoardWorkspace';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProjects } from '@/hooks/useProjects';
import { t } from '@/lib/i18n';
import type { ID } from '@/types';

/**
 * Boards for any project, with a project switcher: its task board and the
 * boards made for it. The project is in the address (`?project=`), beside the
 * board the workspace keeps there.
 */
export default function BoardsPage() {
  const projectsQuery = useProjects();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const project = projectsQuery.data?.find((item) => item.id === projectId);

  // The first project once the list loads, when none is chosen or it went away.
  useEffect(() => {
    const first = projectsQuery.data?.[0]?.id;
    if (first && (!projectId || !projectsQuery.data?.some((item) => item.id === projectId))) {
      setParams({ project: first }, { replace: true });
    }
  }, [projectsQuery.data, projectId, setParams]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Boards')}
        description={t('Visual delivery flow for any project in the portfolio.')}
        meta={project ? <span className="font-mono text-2xs text-muted-foreground">{project.identifier}</span> : null}
        actions={
          <Select value={projectId} onValueChange={(value) => setParams({ project: value as ID }, { replace: true })}>
            <SelectTrigger className="w-56" aria-label={t('Select a project')}>
              <SelectValue placeholder={t('Select a project')} />
            </SelectTrigger>
            <SelectContent>
              {(projectsQuery.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {projectsQuery.isLoading || !projectId ? <PageSkeleton /> : <BoardWorkspace key={projectId} projectId={projectId} />}
    </div>
  );
}
