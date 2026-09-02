import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attachmentService } from '@/services';
import type { ID } from '@/types';

/**
 * Attachments on a work package.
 *
 * Kept off `EpmTask` deliberately: attachments are a related collection that
 * changes on its own schedule, and folding them into the task would mean
 * refetching a work package to learn a file had been added.
 */

export const attachmentKeys = {
  list: (workPackageId: ID) => ['attachments', workPackageId] as const,
};

export function useAttachments(workPackageId?: ID) {
  return useQuery({
    queryKey: attachmentKeys.list(workPackageId ?? 'unknown'),
    queryFn: () => attachmentService.list(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

export function useUploadAttachment(workPackageId: ID) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => attachmentService.upload(workPackageId, file),
    onSuccess: () => client.invalidateQueries({ queryKey: attachmentKeys.list(workPackageId) }),
  });
}

export function useDeleteAttachment(workPackageId: ID) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (attachmentId: ID) => attachmentService.remove(attachmentId),
    onSuccess: () => client.invalidateQueries({ queryKey: attachmentKeys.list(workPackageId) }),
  });
}
