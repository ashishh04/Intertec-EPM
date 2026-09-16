import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { ManagedPanel } from '../ManagedPanel';
import { valueOr, weekDayName } from './shared-format';

/** Date and time formats, read from the configuration. */
export default function DateFormatPage() {
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
        title="Date format"
        description="How dates and times are written across the delivery system, and which day a week begins on."
        facts={[
          { label: 'Date format', value: valueOr(data?.dateFormat, 'Browser default') },
          { label: 'Time format', value: valueOr(data?.timeFormat, 'Browser default') },
          { label: 'Start of week', value: weekDayName(data?.startOfWeek) ?? 'Browser default' },
          { label: 'Default time zone', value: valueOr(data?.userDefaultTimezone, 'Not set') },
        ]}
      />
    </QueryBoundary>
  );
}
