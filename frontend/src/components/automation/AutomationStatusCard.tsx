import type { ReactNode } from 'react';
import { Activity, Bot, Send, Webhook } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAutomationStatus } from '@/hooks/useAutomation';
import { formatRelative } from '@/lib/utils';

/**
 * Whether rules can do their work here: the automation account they act as,
 * the worker that takes events, the webhook that brings changes made in
 * OpenProject itself, and how outbound calls are signed.
 */
export function AutomationStatusCard({ show = 'rules' }: { show?: 'rules' | 'escalation' }) {
  const status = useAutomationStatus(true);
  if (status.isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!status.data) return null;
  const { account, worker, webhook, outbound, escalation } = status.data;

  return (
    <div className="space-y-3">
      {show === 'rules' && !account.working ? (
        <Alert tone="warning" title={account.configured ? 'The automation account key does not work' : 'No automation account is configured'}>
          Rules still notify and call out, but change nothing in OpenProject until there is one. Run{' '}
          <code className="text-2xs">automation-account.rb</code> on the OpenProject container and put the key it prints in{' '}
          <code className="text-2xs">OPENPROJECT_AUTOMATION_API_KEY</code>.
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 py-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={Bot} title="Acts as">
            {account.working ? (
              <>
                {account.name}
                <span className="block text-2xs text-muted-foreground">
                  {account.admin ? 'An administrator — not recommended' : 'Not an administrator; added to a project when a rule acts there'}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Nobody yet</span>
            )}
          </Fact>
          {show === 'rules' ? (
            <>
              <Fact icon={Activity} title="Rule worker">
                {worker.enabled ? `Every ${worker.pollSeconds} s` : 'Switched off'}
                <span className="block text-2xs text-muted-foreground">
                  {worker.queued} queued · {worker.failed} failed this week
                  {worker.lastProcessedAt ? ` · last ${formatRelative(worker.lastProcessedAt)}` : ''}
                </span>
              </Fact>
              <Fact icon={Webhook} title="Changes made in OpenProject">
                {webhook.secretConfigured ? 'Arrive by webhook' : 'Not seen: no webhook secret'}
                <span className="block text-2xs text-muted-foreground">
                  {webhook.lastReceivedAt ? `Last delivery ${formatRelative(webhook.lastReceivedAt)}` : 'No delivery since the server started'}
                </span>
              </Fact>
              <Fact icon={Send} title="Outbound calls">
                {outbound.signing ? 'Signed (X-EPM-Signature)' : 'Not signed'}
                <span className="block text-2xs text-muted-foreground">
                  {outbound.allowlist.length ? `Also allowed: ${outbound.allowlist.join(', ')}` : 'Public https endpoints only'}
                </span>
              </Fact>
            </>
          ) : (
            <Fact icon={Activity} title="Escalation sweep">
              {escalation.enabled ? `Every ${escalation.intervalMinutes} min` : 'Switched off'}
              <span className="block text-2xs text-muted-foreground">
                {escalation.lastRunAt ? `Last ran ${formatRelative(escalation.lastRunAt)}` : 'Not run since the server started'}
              </span>
            </Fact>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ icon: Icon, title, children }: { icon: typeof Bot; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="epm-eyebrow">{title}</p>
        <div className="mt-0.5 font-medium text-foreground">{children}</div>
      </div>
    </div>
  );
}
