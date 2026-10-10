import { useMemo, useState } from 'react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ListToolbar } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { NewsFeed } from '@/components/news/NewsFeed';
import { useProjects } from '@/hooks/useProjects';
import { t } from '@/lib/i18n';

/**
 * Announcements, across everything this person can see.
 *
 * Unfiltered, that means every published post in a project they belong to plus
 * the organisation-wide ones — scoped on the server from OpenProject's own answer
 * about their projects, never filtered in the browser.
 */
export default function NewsPage() {
  const [projectId, setProjectId] = useState<string>();
  const projectsQuery = useProjects();

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('News')}
        description={t('What people need to know rather than find out.')}
      />

      <ListToolbar>
        <div className="w-64">
          <ComboSelect
            label={t('Project')}
            options={projectOptions}
            value={projectId}
            clearable
            loading={projectsQuery.isLoading}
            placeholder={t('Every project')}
            emptyLabel={t('No projects match')}
            onChange={setProjectId}
          />
        </div>
      </ListToolbar>

      {/* Keyed on the filter so the feed's draft switch and pager reset with the
          scope rather than showing page 3 of a shorter list. */}
      <NewsFeed key={projectId ?? 'all'} projectId={projectId} />
    </div>
  );
}
