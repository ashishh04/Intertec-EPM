import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ListToolbar } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { WikiWorkspace } from '@/components/wiki/WikiWorkspace';
import { useProjects } from '@/hooks/useProjects';

/**
 * The wiki.
 *
 * The page being read lives in the path — `/wiki/deployment` — rather than in a
 * query parameter, because that is what makes a wiki link look like a link
 * somebody would paste into a ticket. The project, when there is one, is a query
 * parameter instead: it is a filter over which wiki is open, not part of a page's
 * identity, and the same slug legitimately exists in several projects.
 */
export default function WikiPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const projectId = searchParams.get('projectId') ?? undefined;
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

  const projectName = projectOptions.find((option) => option.id === projectId)?.name;

  /** Moves to a page, keeping whichever wiki is open. */
  const goTo = (next?: string) => {
    const query = projectId ? `?projectId=${projectId}` : '';
    navigate(next ? `/wiki/${next}${query}` : `/wiki${query}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Wiki"
        description={
          projectName
            ? `Written documentation for ${projectName}.`
            : 'Written documentation everybody can reach and anybody can correct.'
        }
      />

      <ListToolbar>
        <div className="w-64">
          <ComboSelect
            label="Wiki"
            options={projectOptions}
            value={projectId}
            clearable
            loading={projectsQuery.isLoading}
            placeholder="Organisation wiki"
            emptyLabel="No projects match"
            onChange={(next) => {
              // Switching wiki drops the slug: the page being read belongs to the
              // wiki it was in, and carrying the address across would land on a
              // "no such page" for something that plainly exists elsewhere.
              setSearchParams(next ? { projectId: next } : {});
              navigate(next ? `/wiki?projectId=${next}` : '/wiki');
            }}
          />
        </div>
      </ListToolbar>

      {/* Keyed on the scope so the workspace re-seeds its editor state when the
          wiki changes rather than carrying a draft across. */}
      <WikiWorkspace
        key={projectId ?? 'organisation'}
        projectId={projectId}
        slug={slug}
        onNavigate={goTo}
      />
    </div>
  );
}
