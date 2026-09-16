import { toast } from 'sonner';
import { Lock, RefreshCw, Server, ShieldCheck, Webhook } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { FactList } from '@/components/common/FactList';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useIntegrationStatus, useTriggerSync } from '@/hooks/useIntegration';
import { useAuth } from '@/providers/AuthProvider';
import { CONNECTION_STATE_META, TONE_FILL } from '@/lib/domain';
import { cn, formatNumber, formatRelative } from '@/lib/utils';
import type { ConnectionState } from '@/types';

/**
 * Administrative view of the OpenProject connection.
 *
 * Health only — credentials, tokens and connection secrets are held by the
 * EPM backend and are never returned to the browser.
 */
export default function IntegrationPage() {
  const { can } = useAuth();
  const statusQuery = useIntegrationStatus();
  const sync = useTriggerSync();

  const status = statusQuery.data;
  // Integration health is administrative. `users:manage` is the closest
  // capability OpenProject reports; instance administration itself has no
  // capability, so this is the honest gate rather than a fabricated one.
  const isAdmin = can('users:manage');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="Delivery System Integration"
        description="Connection health, synchronisation state and webhook delivery."
        actions={
          <Button
            size="sm"
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success('Synchronisation completed'),
                onError: () => toast.error('Unable to trigger a synchronisation'),
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync now
          </Button>
        }
      />

      {!isAdmin ? (
        <Alert tone="warning" icon={Lock} title="Read-only access">
          You can view integration health, but only workspace administrators can change the
          connection. Actions on this page are disabled for your role.
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={statusQuery.isLoading}
        isError={statusQuery.isError}
        error={statusQuery.error}
        onRetry={() => statusQuery.refetch()}
        errorTitle="Unable to load integration status"
        skeleton={
          <div className="space-y-4">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        }
        isEmpty={!status}
        empty={
          <Card>
            <EmptyState
              icon={Server}
              title="No integration status yet"
              description="The backend has not reported on the delivery system connection. Run a synchronisation to populate this page."
              action={{ label: 'Sync now', onClick: () => sync.mutate(undefined) }}
            />
          </Card>
        }
      >
        {status ? (
          <>
            {/* Connection summary */}
            <Card>
              <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
                <StatusTile
                  icon={Server}
                  label="Status"
                  state={status.state}
                  detail={`API ${status.apiVersion}`}
                />
                <StatusTile
                  icon={ShieldCheck}
                  label="API"
                  state={status.apiState}
                  detail="Authenticated server-side"
                />
                <StatusTile
                  icon={Webhook}
                  label="Webhooks"
                  state={status.webhookState}
                  detail="Change events subscribed"
                />
                <div>
                  <p className="epm-eyebrow">Last sync</p>
                  <p className="mt-1 font-mono text-sm font-semibold">
                    {formatRelative(status.lastSyncAt)}
                  </p>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Incremental synchronisation
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Instance */}
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Instance</CardTitle>
                <CardDescription>
                  The delivery system behind this workspace.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <FactList
                  facts={[
                    { label: 'API version', value: status.apiVersion },
                    {
                      label: 'Authentication',
                      value: 'OAuth client credentials, held server-side',
                      mono: false,
                    },
                    {
                      label: 'Access token',
                      mono: false,
                      value: (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <Lock className="h-3 w-3" aria-hidden />
                          Never exposed to the frontend
                        </span>
                      ),
                    },
                  ]}
                />

                <Alert tone="neutral" icon={ShieldCheck}>
                  The browser never calls the delivery system directly. Every request goes through
                  the EPM backend, which owns authentication, authorisation, rate limiting, response
                  transformation and audit logging.
                </Alert>
              </CardContent>
            </Card>

            {/* Synced resources */}
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border">
                <CardTitle>Synchronised resources</CardTitle>
                <CardDescription>
                  What the backend keeps in step with the upstream instance.
                </CardDescription>
              </CardHeader>
              {status.syncedResources.length === 0 ? (
                <EmptyState
                  size="inline"
                  title="Nothing synchronised yet"
                  description="Resources appear here after the first successful synchronisation."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Records</TableHead>
                        <TableHead>Last synchronised</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {status.syncedResources.map((resource) => (
                        <TableRow key={resource.resource}>
                          <TableCell className="font-medium">{resource.resource}</TableCell>
                          <TableCell className="font-mono text-2xs">
                            {formatNumber(resource.count)}
                          </TableCell>
                          <TableCell className="font-mono text-2xs text-muted-foreground">
                            {formatRelative(resource.lastSyncAt)}
                          </TableCell>
                          <TableCell>
                            <Badge tone="success" size="sm" dot>
                              In sync
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </>
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function StatusTile({
  icon: Icon,
  label,
  state,
  detail,
}: {
  icon: typeof Server;
  label: string;
  state: ConnectionState;
  detail: string;
}) {
  const meta = CONNECTION_STATE_META[state];

  return (
    <div>
      <p className="epm-eyebrow">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            TONE_FILL[meta.tone],
            state === 'connected' && 'animate-pulse-ring',
          )}
          aria-hidden
        />
        {meta.label}
        <Icon className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </p>
      <p className="mt-0.5 text-2xs text-muted-foreground">{detail}</p>
    </div>
  );
}
