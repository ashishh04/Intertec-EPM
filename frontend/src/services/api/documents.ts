import { apiClient } from './client';
import { env } from '@/config/env';
import type { DocumentRepository } from '../repositories';
import type { ID, EpmDocument } from '@/types';

export class ApiDocumentRepository implements DocumentRepository {
  getDocuments(params: { projectId?: ID; search?: string } = {}): Promise<EpmDocument[]> {
    return apiClient.get<EpmDocument[]>('/documents', params);
  }

  /**
   * Uploads one file.
   *
   * Sent as multipart with the browser's own File object, so the bytes are
   * streamed rather than read into memory and re-encoded. `apiClient` is
   * bypassed because it serializes JSON; the session cookie still travels,
   * which is what authorises the request. Same shape as an attachment upload.
   */
  async uploadDocument(file: File, options: { projectId?: ID; shared?: boolean } = {}): Promise<EpmDocument> {
    const body = new FormData();
    // Fields before the file: the backend reads them off the same part stream,
    // and a field that arrives after the file has already been consumed is lost.
    if (options.projectId) body.append('projectId', options.projectId);
    if (options.shared !== undefined) body.append('shared', String(options.shared));
    body.append('file', file, file.name);

    const response = await fetch(`${env.apiBaseUrl}/documents`, {
      method: 'POST',
      credentials: 'include',
      body,
    });

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(failure.message ?? 'The upload failed.');
    }

    return (await response.json()) as EpmDocument;
  }

  /**
   * Removes a document: the stored file and the row that indexes it.
   *
   * Offered only where `document.can.delete` is true, which the backend reads
   * off the attachment's own affordances — so this is never the first place a
   * refusal is discovered, but it still surfaces one if it comes.
   */
  deleteDocument(documentId: ID): Promise<void> {
    return apiClient.delete<void>(`/documents/${documentId}`);
  }

  /** Where the browser can fetch the file itself. Proxied, never an upstream URL. */
  downloadUrl(documentId: ID): string {
    return `${env.apiBaseUrl}/documents/${documentId}/content`;
  }
}
