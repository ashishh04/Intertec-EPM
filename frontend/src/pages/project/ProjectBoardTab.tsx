import { useParams } from 'react-router-dom';

import { BoardWorkspace } from '@/components/board/BoardWorkspace';

/** A project's boards: its task board, and the boards made for it. */
export default function ProjectBoardTab() {
  const { projectId } = useParams();
  if (!projectId) return null;
  return <BoardWorkspace projectId={projectId} />;
}
