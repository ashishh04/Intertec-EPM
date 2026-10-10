import { useParams } from 'react-router-dom';
import { QueryWorkspace } from '@/components/tasks/QueryWorkspace';
import { RecurringWorkList, TasksViewSwitch, useTasksView } from '@/components/tasks/RecurringWorkList';

/** All work packages inside one project, or its recurring work (`?view=recurring`). */
export default function ProjectTasksTab() {
  const { projectId } = useParams();
  const [view, setView] = useTasksView();
  return (
    <div className="space-y-4">
      <TasksViewSwitch view={view} onChange={setView} />
      {view === 'recurring' ? <RecurringWorkList projectId={projectId} /> : <QueryWorkspace projectId={projectId} />}
    </div>
  );
}
