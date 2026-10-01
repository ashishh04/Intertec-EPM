import { apiClient } from './client';
import type { EpmBrowserSession, ID } from '@/types';

/**
 * The signed-in person's own sessions.
 *
 * EPM's own, not OpenProject's — sessions here are server-side rows, so there is
 * a real list to show and revoking one takes effect on that browser's next
 * request. Nothing in a record is a credential; the browser only ever held an
 * opaque id in the first place.
 */
export class ApiSessionRepository {
  list(): Promise<EpmBrowserSession[]> {
    return apiClient.get<EpmBrowserSession[]>('/me/sessions');
  }

  /** Ends one other session. The current one is refused by the backend. */
  revoke(id: ID): Promise<void> {
    return apiClient.delete<void>(`/me/sessions/${id}`);
  }

  /** Ends every session but this one, and reports how many that was. */
  revokeOthers(): Promise<{ revoked: number }> {
    return apiClient.post<{ revoked: number }>('/me/sessions/revoke-others');
  }
}
