import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * Comments on a work package.
 *
 * `body` is markdown source, not rendered html. OpenProject returns both, and
 * the backend deliberately withholds the rendered form so no upstream markup is
 * ever injected into this origin — it is rendered as text here.
 *
 * There is no remove method because OpenProject offers no way to delete a
 * comment. `deletable` is reported all the same, read from the affordance, so
 * it is already wired if that ever changes.
 */

export interface EpmComment {
  id: ID;
  author: { id: ID; name: string };
  body: string;
  createdAt: string;
  /** Set only when the comment has been edited since it was written. */
  updatedAt?: string;
  editable: boolean;
  deletable: boolean;
}

export class ApiCommentRepository {
  list(workPackageId: ID): Promise<EpmComment[]> {
    return apiClient.get<EpmComment[]>(`/work-packages/${workPackageId}/comments`);
  }

  create(workPackageId: ID, body: string): Promise<EpmComment> {
    return apiClient.post<EpmComment>(`/work-packages/${workPackageId}/comments`, { body });
  }

  update(workPackageId: ID, commentId: ID, body: string): Promise<EpmComment> {
    return apiClient.patch<EpmComment>(
      `/work-packages/${workPackageId}/comments/${commentId}`,
      { body },
    );
  }
}
