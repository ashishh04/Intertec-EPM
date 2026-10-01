import { useSearchParams, useParams } from 'react-router-dom';

import { WikiWorkspace } from '@/components/wiki/WikiWorkspace';

/**
 * This project's wiki.
 *
 * The page being read is a search parameter here rather than a path segment,
 * unlike the standalone Wiki page: the project's own tab routes are fixed
 * segments, and adding an optional one under `wiki` would make `/wiki/history`
 * ambiguous with a page called "history".
 */
export default function ProjectWikiTab() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <WikiWorkspace
      key={projectId}
      projectId={projectId}
      slug={searchParams.get('page') ?? undefined}
      onNavigate={(slug) => setSearchParams(slug ? { page: slug } : {})}
    />
  );
}
