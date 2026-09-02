import { apiClient } from './client';
import { env } from '@/config/env';
import type { ID } from '@/types';

/**
 * Work package attachments.
 *
 * Uploads and downloads both go through the EPM backend. The browser is never
 * given an OpenProject URL, and could not use one if it were — no upstream
 * credential ever reaches it.
 */

export interface EpmAttachment {
  id: ID;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: string;
  description?: string;
  authorId?: ID;
  /** What this user may do with it, as OpenProject reports it. */
  can: { delete: boolean };
}

export class ApiAttachmentRepository {
  list(workPackageId: ID): Promise<EpmAttachment[]> {
    return apiClient.get<EpmAttachment[]>(`/work-packages/${workPackageId}/attachments`);
  }

  /**
   * Uploads one file.
   *
   * Sent as multipart with the browser's own File object, so the bytes are
   * streamed by the browser rather than read into memory and re-encoded.
   * `apiClient` is bypassed here because it serializes JSON; the session cookie
   * still travels, which is what authorises the request.
   */
  async upload(workPackageId: ID, file: File): Promise<EpmAttachment> {
    const body = new FormData();
    body.append('file', file, file.name);

    const response = await fetch(`${env.apiBaseUrl}/work-packages/${workPackageId}/attachments`, {
      method: 'POST',
      credentials: 'include',
      body,
    });

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(failure.message ?? 'The upload failed.');
    }

    return (await response.json()) as EpmAttachment;
  }

  remove(attachmentId: ID): Promise<void> {
    return apiClient.delete<void>(`/attachments/${attachmentId}`);
  }

  /**
   * Where the browser should navigate to download a file.
   *
   * An EPM URL, always. The backend authenticates the session, fetches from
   * OpenProject with the caller's own token, and streams the result back.
   */
  downloadUrl(attachmentId: ID): string {
    return `${env.apiBaseUrl}/attachments/${attachmentId}/content`;
  }
}
