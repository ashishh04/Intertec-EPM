import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
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
      errorTitle="Configuration could not be loaded"
      skeleton={<ListSkeleton rows={1} height="h-64" />}
    >
      <ManagedPanel
        title="General"
        description="The instance's identity and the defaults every page and list inherits."
        facts={[
          { label: 'Host name', value: valueOr(data?.hostName, 'Not set') },
          { label: 'Per-page options', value: joinOrFallback(data?.perPageOptions) },
          { label: 'Duration format', value: valueOr(data?.durationFormat, 'Not set') },
          { label: 'Hours per day', value: valueOr(data?.hoursPerDay, 'Not set') },
          { label: 'Days per month', value: valueOr(data?.daysPerMonth, 'Not set') },
          { label: 'Allowed link protocols', value: joinOrFallback(data?.allowedLinkProtocols, 'None') },
        ]}
      />
    </QueryBoundary>
  );
}
