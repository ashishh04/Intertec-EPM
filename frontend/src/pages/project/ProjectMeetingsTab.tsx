import { useParams } from 'react-router-dom';

import { MeetingList } from '@/components/meetings/MeetingList';

/** This project's meetings. The same list the Meetings page renders, scoped. */
export default function ProjectMeetingsTab() {
  const { projectId } = useParams();

  return <MeetingList key={projectId} projectId={projectId} scoped />;
}
