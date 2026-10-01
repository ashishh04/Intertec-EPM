import { Lock, ShieldCheck } from 'lucide-react';

import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminEnterprise } from '@/hooks/useAdmin';

/**
 * Enterprise edition status.
 *
 * This was a `managed` page, which meant it rendered a title, a sentence and an
 * empty card — the screen that gets reported as broken because it looks like one.
 * EPM already reads the instance's licence state to decide whether to offer
 * Enterprise-gated actions, so the page can simply show what it knows.
 *
 * It still cannot *change* anything: a licence is applied in the OpenProject
 * administration and there is no API for it. But "here is your licence state and
 * what it gates" is a page; "here is a heading" is not.
 */

/** What each gated feature is, so the list reads as capabilities rather than keys. */
const FEATURE_LABELS: Record<string, string> = {
  placeholderUsers: 'Placeholder users',
};

/** `placeholderUsers` → `Placeholder users`, for a feature added after this shipped. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default function EnterprisePage() {
  const enterprise = useAdminEnterprise();

  return (
    <QueryBoundary
      isLoading={enterprise.isLoading}
      isError={enterprise.isError}
      error={enterprise.error}
      onRetry={() => enterprise.refetch()}
      errorTitle="Unable to read the licence state"
      skeleton={<Skeleton className="h-64 w-full rounded-xl" />}
    >
      <div className="space-y-4">
        <Card>
          <CardHeader variant="compact">
            <CardTitle>Enterprise edition</CardTitle>
            <CardDescription>
              The support token that unlocks Enterprise features on this instance.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {enterprise.data?.active ? (
              <Alert tone="success" icon={ShieldCheck} title="Licensed">
                This instance holds an Enterprise token, so the features below are available.
              </Alert>
            ) : (
              <Alert tone="neutral" icon={Lock} title="Community edition">
                This instance holds no Enterprise token. Everything below is unavailable, and no
                change in EPM can enable it — a licence has to be applied to OpenProject itself.
              </Alert>
            )}

            <FactList
              facts={[
                {
                  label: 'Licence',
                  mono: false,
                  value: (
                    <Badge tone={enterprise.data?.active ? 'success' : 'neutral'} size="sm" dot>
                      {enterprise.data?.active ? 'Active' : 'Not active'}
                    </Badge>
                  ),
                },
              ]}
            />

            <p className="text-xs text-muted-foreground">
              A token is applied in the OpenProject administration, under{' '}
              <span className="font-medium text-foreground">Enterprise edition</span>. EPM reads the
              result; it cannot set it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader variant="compact">
            <CardTitle>Gated features</CardTitle>
            <CardDescription>
              What EPM checks this licence for before offering an action.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            {/* Only the features EPM actually asks about. The list comes from the
                instance rather than being written here, so a feature added to the
                check appears without a frontend release. */}
            {Object.keys(enterprise.data?.allows ?? {}).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                EPM does not currently gate any action on an Enterprise licence.
              </p>
            ) : (
              <FactList
                facts={Object.entries(enterprise.data?.allows ?? {}).map(([key, allowed]) => ({
                  label: FEATURE_LABELS[key] ?? humanize(key),
                  mono: false,
                  value: (
                    <Badge tone={allowed ? 'success' : 'neutral'} size="sm">
                      {allowed ? 'Available' : 'Not licensed'}
                    </Badge>
                  ),
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </QueryBoundary>
  );
}
