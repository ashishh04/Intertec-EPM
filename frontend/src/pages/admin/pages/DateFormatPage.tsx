import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
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
      errorTitle={t('Configuration could not be loaded')}
      skeleton={<ListSkeleton rows={1} height="h-64" />}
    >
      <ManagedPanel
        title={t('Date format')}
        description={t('How dates and times are written across the delivery system, and which day a week begins on.')}
        facts={[
          { label: t('Date format'), value: valueOr(data?.dateFormat, t('Browser default')) },
          { label: t('Time format'), value: valueOr(data?.timeFormat, t('Browser default')) },
          { label: t('Start of week'), value: weekDayName(data?.startOfWeek) ?? t('Browser default') },
          { label: t('Default time zone'), value: valueOr(data?.userDefaultTimezone, t('Not set')) },
        ]}
      />
    </QueryBoundary>
  );
}
