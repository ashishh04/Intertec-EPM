import { Link } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { ListSkeleton } from '@/components/common/DataTable';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env } from '@/config/env';
import { useAdminInformation } from '@/hooks/useAdmin';
import { valueOr } from './shared-format';

/** The APIs in play: EPM's own backend and the delivery system it reads from. */
export default function ApiPage() {
  const information = useAdminInformation();
  const data = information.data;

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>API</CardTitle>
        <CardDescription>How EPM talks to its backend, and which delivery system API sits behind it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <QueryBoundary
          isLoading={information.isLoading}
          isError={information.isError}
          error={information.error}
          onRetry={() => void information.refetch()}
          errorTitle="Instance information could not be loaded"
          skeleton={<ListSkeleton rows={3} height="h-10" />}
        >
          <FactList
            facts={[
              {
                label: 'EPM API base URL',
                value: (
                  <span className="block truncate" title={env.apiBaseUrl}>
                    {env.apiBaseUrl}
                  </span>
                ),
              },
              { label: 'Delivery system API version', value: valueOr(data?.apiVersion, 'Unknown') },
              { label: 'Instance version', value: valueOr(data?.coreVersion, 'Unknown') },
            ]}
          />
        </QueryBoundary>

        <Alert tone="danger" icon={Lock}>
          API tokens are never exposed to the frontend and cannot be viewed or rotated from this
          interface. The frontend never receives an upstream URL or token.
        </Alert>

        <Button asChild variant="secondary" size="sm">
          <Link to="/settings/integration">
            Open integration status
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
