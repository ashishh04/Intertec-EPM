import { toast } from 'sonner';
import { Lock, RefreshCw, Server, ShieldCheck, Webhook } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { InboundEventsCard } from '@/components/integration/InboundEventsCard';
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
import { t } from '@/lib/i18n';
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
        eyebrow={t('Administration')}
        title={t('Delivery System Integration')}
        description={t('Connection health, record counts and webhook delivery.')}
        actions={
          <Button
            size="sm"
            loading={sync.isPending}
            disabled={!isAdmin}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success(t('Connection checked and records counted')),
                onError: () => toast.error(t('Unable to check the connection')),
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('Check now')}
          </Button>
        }
      />

      {!isAdmin ? (
        <Alert tone="warning" icon={Lock} title={t('Read-only access')}>
          {t(
            'You can view integration health, but only workspace administrators can change the connection. Actions on this page are disabled for your role.',
          )}
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={statusQuery.isLoading}
        isError={statusQuery.isError}
        error={statusQuery.error}
        onRetry={() => statusQuery.refetch()}
        errorTitle={t('Unable to load integration status')}
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
              title={t('No integration status yet')}
              description={t(
                'The backend has not reported on the delivery system connection. Check the connection to populate this page.',
              )}
              action={
                isAdmin ? { label: t('Check now'), onClick: () => sync.mutate(undefined) } : undefined
              }
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
                  label={t('Status')}
                  state={status.state}
                  detail={`API ${status.apiVersion}`}
                />
                <StatusTile
                  icon={ShieldCheck}
                  label="API"
                  state={status.apiState}
                  detail={t('Authenticated server-side')}
                />
                <StatusTile
                  icon={Webhook}
                  label={t('Webhooks')}
                  state={status.webhookState}
                  detail={
                    status.webhookState !== 'connected'
                      ? t('Not configured')
                      : status.webhookLastReceivedAt
                        ? t('Last delivery {time}', { time: formatRelative(status.webhookLastReceivedAt) })
                        : t('Signed deliveries accepted; none since the server started')
                  }
                />
                <div>
                  <p className="epm-eyebrow">{t('Last check')}</p>
                  <p className="mt-1 font-mono text-sm font-semibold">
                    {formatRelative(status.lastSyncAt)}
                  </p>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    {t('Records counted on demand')}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Instance */}
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>{t('Instance')}</CardTitle>
                <CardDescription>
                  {t('The delivery system behind this workspace.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <FactList
                  facts={[
                    { label: t('API version'), value: status.apiVersion },
                    {
                      label: t('Authentication'),
                      value: t('A service key and each person\'s own token, held server-side'),
                      mono: false,
                    },
                    {
                      label: t('Access token'),
                      mono: false,
                      value: (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <Lock className="h-3 w-3" aria-hidden />
                          {t('Never exposed to the frontend')}
                        </span>
                      ),
                    },
                  ]}
                />

                <Alert tone="neutral" icon={ShieldCheck}>
                  {t(
                    'The browser never calls the delivery system directly. Every request goes through the EPM backend, which owns authentication, authorisation, rate limiting and response transformation, and journals the changes EPM itself makes.',
                  )}
                </Alert>
              </CardContent>
            </Card>

            {/* Synced resources */}
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border">
                <CardTitle>{t('Records in the delivery system')}</CardTitle>
                <CardDescription>
                  {t(
                    'Counted at the last check. Nothing is copied: the delivery system stays the system of record and EPM reads it live.',
                  )}
                </CardDescription>
              </CardHeader>
              {status.syncedResources.length === 0 ? (
                <EmptyState
                  size="inline"
                  title={t('Nothing counted yet')}
                  description={t('Resources appear here after the first successful check.')}
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('Resource')}</TableHead>
                        <TableHead>{t('Records')}</TableHead>
                        <TableHead>{t('Counted')}</TableHead>
                        <TableHead>{t('State')}</TableHead>
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
                              {t('Readable')}
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
      {isAdmin ? <InboundEventsCard /> : null}
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
        <Icon className="ms-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </p>
      <p className="mt-0.5 text-2xs text-muted-foreground">{detail}</p>
    </div>
  );
}
