import { ListSkeleton } from '@/components/common/DataTable';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { APP_NAME, env } from '@/config/env';
import { useAdminInformation } from '@/hooks/useAdmin';
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
          <CardTitle>Delivery system</CardTitle>
          <CardDescription>The instance EPM reads projects, work packages and people from.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <QueryBoundary
            isLoading={information.isLoading}
            isError={information.isError}
            error={information.error}
            onRetry={() => void information.refetch()}
            errorTitle="Instance information could not be loaded"
            skeleton={<ListSkeleton rows={5} height="h-10" />}
          >
            <FactList
              facts={[
                { label: 'Instance name', value: valueOr(data?.instanceName, 'Not set') },
                { label: 'Core version', value: valueOr(data?.coreVersion, 'Unknown') },
                { label: 'Host name', value: valueOr(data?.hostName, 'Not set') },
                { label: 'API version', value: valueOr(data?.apiVersion, 'Unknown') },
                {
                  label: 'Active feature flags',
                  value:
                    flags.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5" title={flags.join(', ')}>
                        {formatNumber(flags.length)}
                        <span className="sr-only">: {flags.join(', ')}</span>
                      </span>
                    ) : (
                      'None'
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
          <CardDescription>This application and the backend it talks to.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <FactList
            facts={[
              { label: 'App name', value: APP_NAME, mono: false },
              { label: 'Environment', value: env.appEnv },
              {
                label: 'API base URL',
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
