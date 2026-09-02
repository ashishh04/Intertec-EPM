import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, Paperclip, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import {
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from '@/hooks/useAttachments';
import { useUserMap } from '@/hooks/useUsers';
import { attachmentService } from '@/services';
import { formatBytes } from '@/lib/utils';
import type { ID } from '@/types';

/**
 * Files attached to a work package.
 *
 * Upload and download both go through the EPM backend; the browser never sees
 * an OpenProject URL. Delete is offered only where OpenProject publishes the
 * affordance, and the backend refuses it regardless of what is shown.
 */

interface TaskAttachmentsProps {
  workPackageId: ID;
  /** Whether this user may attach files, from their project permissions. */
  canUpload: boolean;
}

export function TaskAttachments({ workPackageId, canUpload }: TaskAttachmentsProps) {
  const attachments = useAttachments(workPackageId);
  const upload = useUploadAttachment(workPackageId);
  const remove = useDeleteAttachment(workPackageId);
  const users = useUserMap();

  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string>();

  const send = (file: File) => {
    setPending(file.name);
    upload.mutate(file, {
      onSuccess: (attachment) => toast.success(`Uploaded ${attachment.fileName}`),
      onError: (error) =>
        toast.error('Upload failed', {
          description: error instanceof Error ? error.message : undefined,
        }),
      onSettled: () => {
        setPending(undefined);
        // Lets the same file be chosen again after a failure.
        if (input.current) input.current.value = '';
      },
    });
  };

  const files = attachments.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-muted-foreground" aria-hidden />
          Attachments
          {files.length > 0 ? (
            <span className="text-2xs font-normal text-muted-foreground">{files.length}</span>
          ) : null}
        </CardTitle>

        {canUpload ? (
          <>
            <input
              ref={input}
              type="file"
              className="sr-only"
              aria-label="Choose a file to attach"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) send(file);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-8"
              loading={upload.isPending}
              onClick={() => input.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload
            </Button>
          </>
        ) : null}
      </CardHeader>

      <CardContent className="pt-4">
        {attachments.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : files.length === 0 && !pending ? (
          <EmptyState
            icon={Paperclip}
            title="No attachments"
            description={
              canUpload
                ? 'Upload a file to keep it with this work package.'
                : 'No files have been attached to this work package.'
            }
          />
        ) : (
          <ul className="space-y-1.5">
            {pending ? (
              <li className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2">
                <Upload className="h-4 w-4 shrink-0 animate-pulse text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  Uploading {pending}…
                </span>
              </li>
            ) : null}

            {files.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{attachment.fileName}</p>
                  <p className="text-2xs text-muted-foreground">
                    {formatBytes(attachment.fileSize)}
                    {attachment.contentType ? ` · ${attachment.contentType}` : ''}
                    {` · ${attachment.createdAt.slice(0, 10)}`}
                  </p>
                </div>

                {attachment.authorId ? (
                  <UserAvatarWithTooltip user={users.get(attachment.authorId)} size="xs" />
                ) : null}

                {/* A plain link, so the browser handles the download itself and
                    the file is never held in memory here. */}
                <a
                  href={attachmentService.downloadUrl(attachment.id)}
                  download={attachment.fileName}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Download ${attachment.fileName}`}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                </a>

                {attachment.can.delete ? (
                  <button
                    type="button"
                    aria-label={`Delete ${attachment.fileName}`}
                    className="rounded p-1.5 text-muted-foreground hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      if (!window.confirm(`Delete ${attachment.fileName}?`)) return;
                      remove.mutate(attachment.id, {
                        onSuccess: () => toast.success('Attachment deleted'),
                        onError: (error) =>
                          toast.error('Could not delete', {
                            description: error instanceof Error ? error.message : undefined,
                          }),
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
