import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useAdminConfiguration } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
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
      errorTitle={t('Configuration could not be loaded')}
      skeleton={<ListSkeleton rows={1} height="h-56" />}
    >
      <ManagedPanel
        title={t('Settings')}
        description={t('How logged time is converted between hours, days and months, and how durations are written.')}
        facts={[
          { label: t('Hours per day'), value: valueOr(data?.hoursPerDay, t('Not set')) },
          { label: t('Days per month'), value: valueOr(data?.daysPerMonth, t('Not set')) },
          { label: t('Duration format'), value: valueOr(data?.durationFormat, t('Not set')) },
        ]}
      />
    </QueryBoundary>
  );
}
