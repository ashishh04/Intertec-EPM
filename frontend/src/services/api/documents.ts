import { apiClient } from './client';
import type { DocumentRepository } from '../repositories';
import type { ID, EpmDocument } from '@/types';

export class ApiDocumentRepository implements DocumentRepository {
  getDocuments(params: { projectId?: ID; search?: string } = {}): Promise<EpmDocument[]> {
    return apiClient.get<EpmDocument[]>('/documents', params);
  }

  uploadDocument(file: { name: string; sizeBytes: number; projectId?: ID }): Promise<EpmDocument> {
    return apiClient.post<EpmDocument>('/documents', file);
  }
}
