import { useParams } from 'react-router-dom';

import { NewsFeed } from '@/components/news/NewsFeed';

/** This project's announcements. The same feed the News page renders, scoped. */
export default function ProjectNewsTab() {
  const { projectId } = useParams();

  return <NewsFeed key={projectId} projectId={projectId} scoped />;
}
