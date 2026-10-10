import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
import { ManagedPanel } from '../ManagedPanel';
import { joinOrFallback, valueOr } from './shared-format';

/** General instance settings, read from the configuration. */
export default function GeneralSettingsPage() {
  const configuration = useAdminConfiguration();
  const data = configuration.data;

  return (
    <QueryBoundary
      isLoading={configuration.isLoading}
      isError={configuration.isError}
      error={configuration.error}
      onRetry={() => void configuration.refetch()}
      errorTitle={t('Configuration could not be loaded')}
      skeleton={<ListSkeleton rows={1} height="h-64" />}
    >
      <ManagedPanel
        title={t('General')}
        description={t('The instance\'s identity and the defaults every page and list inherits.')}
        facts={[
          { label: t('Host name'), value: valueOr(data?.hostName, t('Not set')) },
          { label: t('Per-page options'), value: joinOrFallback(data?.perPageOptions) },
          { label: t('Duration format'), value: valueOr(data?.durationFormat, t('Not set')) },
          { label: t('Hours per day'), value: valueOr(data?.hoursPerDay, t('Not set')) },
          { label: t('Days per month'), value: valueOr(data?.daysPerMonth, t('Not set')) },
          { label: t('Allowed link protocols'), value: joinOrFallback(data?.allowedLinkProtocols, t('None')) },
        ]}
      />
    </QueryBoundary>
  );
}
