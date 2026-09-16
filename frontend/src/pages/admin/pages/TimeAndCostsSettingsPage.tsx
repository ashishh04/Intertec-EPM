import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { ManagedPanel } from '../ManagedPanel';
import { valueOr } from './shared-format';

/** Time and costs settings, read from the configuration. */
export default function TimeAndCostsSettingsPage() {
  const configuration = useAdminConfiguration();
  const data = configuration.data;

  return (
    <QueryBoundary
      isLoading={configuration.isLoading}
      isError={configuration.isError}
      error={configuration.error}
      onRetry={() => void configuration.refetch()}
      errorTitle="Configuration could not be loaded"
      skeleton={<ListSkeleton rows={1} height="h-56" />}
    >
      <ManagedPanel
        title="Settings"
        description="How logged time is converted between hours, days and months, and how durations are written."
        facts={[
          { label: 'Hours per day', value: valueOr(data?.hoursPerDay, 'Not set') },
          { label: 'Days per month', value: valueOr(data?.daysPerMonth, 'Not set') },
          { label: 'Duration format', value: valueOr(data?.durationFormat, 'Not set') },
        ]}
      />
    </QueryBoundary>
  );
}
