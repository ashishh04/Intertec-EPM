import { apiClient } from './client';
import type { DocumentRepository } from '../repositories';
import type { ID, NexusDocument } from '@/types';

export class ApiDocumentRepository implements DocumentRepository {
  getDocuments(params: { projectId?: ID; search?: string } = {}): Promise<NexusDocument[]> {
    return apiClient.get<NexusDocument[]>('/documents', params);
  }

  uploadDocument(file: { name: string; sizeBytes: number; projectId?: ID }): Promise<NexusDocument> {
    return apiClient.post<NexusDocument>('/documents', file);
  }
}
