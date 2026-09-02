import { useParams } from 'react-router-dom';
import { QueryWorkspace } from '@/components/tasks/QueryWorkspace';

/** All work packages inside one project. */
export default function ProjectTasksTab() {
  const { projectId } = useParams();
  return <QueryWorkspace projectId={projectId} />;
}
