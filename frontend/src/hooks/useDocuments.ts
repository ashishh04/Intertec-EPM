import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

export function useDocuments(params: { projectId?: ID; search?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.documents(params),
    queryFn: () => documentService.getDocuments(params),
    staleTime: 60_000,
  });
}

export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: { name: string; sizeBytes: number; projectId?: ID }) =>
      documentService.uploadDocument(file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });
}
