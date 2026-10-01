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
    mutationFn: ({ file, ...options }: { file: File; projectId?: ID; shared?: boolean }) =>
      documentService.uploadDocument(file, options),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/**
 * Deletes a document.
 *
 * Invalidates `['documents']` wholesale rather than one key: the same file is
 * listed by the workspace library, by every search and project filter, and by
 * the project's own Documents tab, and a deleted file must not survive in any
 * of them.
 */
export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: ID) => documentService.deleteDocument(documentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/**
 * Where the browser can fetch a document's bytes.
 *
 * A path into EPM, never an OpenProject URL: the browser holds no upstream
 * credential, and the instance is not its business.
 */
export function documentDownloadUrl(documentId: ID): string {
  return documentService.downloadUrl(documentId);
}
