import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/utils';
import { ManagedPanel } from '../ManagedPanel';

/**
 * Attachment limits, read from the configuration. One component serves both
 * System settings > Attachments and Files > Attachments.
 */
export default function AttachmentsPage() {
  const configuration = useAdminConfiguration();
  const size = configuration.data?.maximumAttachmentFileSize;

  return (
    <QueryBoundary
      isLoading={configuration.isLoading}
      isError={configuration.isError}
      error={configuration.error}
      onRetry={() => void configuration.refetch()}
      errorTitle={t('Configuration could not be loaded')}
      skeleton={<ListSkeleton rows={1} height="h-48" />}
    >
      <ManagedPanel
        title={t('Attachments')}
        description={t('The largest file anyone may attach to a work package, wiki page or document.')}
        facts={[
          {
            label: t('Maximum attachment size'),
            value: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? formatBytes(size) : t('Not set'),
          },
        ]}
      />
    </QueryBoundary>
  );
}
