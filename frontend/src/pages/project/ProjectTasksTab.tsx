import { useParams } from 'react-router-dom';
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace';

/** All work packages inside one project. */
export default function ProjectTasksTab() {
  const { projectId } = useParams();
  return <TaskWorkspace projectId={projectId} />;
}
