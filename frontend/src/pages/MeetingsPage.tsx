import { useMemo, useState } from 'react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ListToolbar } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { MeetingList } from '@/components/meetings/MeetingList';
import { useProjects } from '@/hooks/useProjects';

/**
 * Meetings across everything this person can see.
 *
 * The project filter narrows rather than being required: without it the list is
 * every meeting in a project they belong to plus the organisation-wide ones,
 * which is the question "what is coming up" actually asks. Scoping is done on the
 * server, from OpenProject's own answer about which projects they can see.
 */
export default function MeetingsPage() {
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
        title="Meetings"
        description="Agendas before, minutes after, and who was actually there."
      />

      <ListToolbar>
        <div className="w-64">
          <ComboSelect
            label="Project"
            options={projectOptions}
            value={projectId}
            clearable
            loading={projectsQuery.isLoading}
            placeholder="Every project"
            emptyLabel="No projects match"
            onChange={setProjectId}
          />
        </div>
      </ListToolbar>

      {/* Keyed on the filter so the list's own window tab and pager reset when
          the scope changes, rather than showing page 4 of a shorter list. */}
      <MeetingList key={projectId ?? 'all'} projectId={projectId} />
    </div>
  );
}
