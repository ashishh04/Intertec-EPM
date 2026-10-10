import { ListSkeleton } from '@/components/common/DataTable';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { APP_NAME, env } from '@/config/env';
import { useAdminInformation } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { valueOr } from './shared-format';

/**
 * Information, shaped like OpenProject's page of the same name: what the
 * instance is and which version it runs, followed by the same for EPM.
 */
export default function InformationPage() {
  const information = useAdminInformation();
  const data = information.data;
  const flags = data?.activeFeatureFlags ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Delivery system')}</CardTitle>
          <CardDescription>{t('The instance EPM reads projects, work packages and people from.')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <QueryBoundary
            isLoading={information.isLoading}
            isError={information.isError}
            error={information.error}
            onRetry={() => void information.refetch()}
            errorTitle={t('Instance information could not be loaded')}
            skeleton={<ListSkeleton rows={5} height="h-10" />}
          >
            <FactList
              facts={[
                { label: t('Instance name'), value: valueOr(data?.instanceName, t('Not set')) },
                { label: t('Core version'), value: valueOr(data?.coreVersion, t('Unknown')) },
                { label: t('Host name'), value: valueOr(data?.hostName, t('Not set')) },
                { label: t('API version'), value: valueOr(data?.apiVersion, t('Unknown')) },
                {
                  label: t('Active feature flags'),
                  value:
                    flags.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5" title={flags.join(', ')}>
                        {formatNumber(flags.length)}
                        <span className="sr-only">: {flags.join(', ')}</span>
                      </span>
                    ) : (
                      t('None')
                    ),
                },
              ]}
            />
          </QueryBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          variant="compact"
          actions={
            <Badge tone="highlight" size="sm" className="capitalize">
              {env.appEnv}
            </Badge>
          }
        >
          <CardTitle>{APP_NAME}</CardTitle>
          <CardDescription>{t('This application and the backend it talks to.')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <FactList
            facts={[
              { label: t('App name'), value: APP_NAME, mono: false },
              { label: t('Environment'), value: env.appEnv },
              {
                label: t('API base URL'),
                value: (
                  <span className="block truncate" title={env.apiBaseUrl}>
                    {env.apiBaseUrl}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
