import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { commentService } from '@/services';
import type { ID } from '@/types';

/**
 * Comments on a work package.
 *
 * Mutations refetch rather than patching the cache. Upstream stores comments as
 * journal entries and can fold a new one into a recent entry instead of adding
 * a row, so what a write returns is not always what the list will look like —
 * an optimistic append would sometimes show a comment that is not there.
 */

export const commentKeys = {
  list: (workPackageId: ID) => ['comments', workPackageId] as const,
  internal: (workPackageId: ID) => ['comments', workPackageId, 'internal'] as const,
};

export function useComments(workPackageId?: ID) {
  return useQuery({
    queryKey: commentKeys.list(workPackageId ?? 'unknown'),
    queryFn: () => commentService.list(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

function useCommentInvalidation(workPackageId: ID) {
  const client = useQueryClient();

  return () => {
    void client.invalidateQueries({ queryKey: commentKeys.list(workPackageId) });
    // A comment is a journal entry, so the activity feed changed too.
    void client.invalidateQueries({ queryKey: ['activity'] });
  };
}

export function useAddComment(workPackageId: ID) {
  const settle = useCommentInvalidation(workPackageId);

  return useMutation({
    mutationFn: (body: string) => commentService.create(workPackageId, body),
    onSuccess: settle,
  });
}

export function useEditComment(workPackageId: ID) {
  const settle = useCommentInvalidation(workPackageId);

  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: ID; body: string }) =>
      commentService.update(workPackageId, commentId, body),
    onSuccess: settle,
  });
}

/** Internal comments: for the organisation’s own people, never shown to an external user. */
export function useInternalComments(workPackageId?: ID) {
  return useQuery({
    queryKey: commentKeys.internal(workPackageId ?? 'unknown'),
    queryFn: () => commentService.listInternal(workPackageId!),
    enabled: Boolean(workPackageId),
    staleTime: 30_000,
  });
}

export function useInternalCommentMutations(workPackageId: ID) {
  const client = useQueryClient();
  const settle = () => void client.invalidateQueries({ queryKey: commentKeys.internal(workPackageId) });
  return {
    add: useMutation({ mutationFn: (body: string) => commentService.createInternal(workPackageId, body), onSuccess: settle }),
    edit: useMutation({ mutationFn: ({ commentId, body }: { commentId: ID; body: string }) => commentService.updateInternal(commentId, body), onSuccess: settle }),
    remove: useMutation({ mutationFn: (commentId: ID) => commentService.removeInternal(commentId), onSuccess: settle }),
  };
}
