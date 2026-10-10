import type { ReactNode } from 'react';
import { Activity, Bot, Send, Webhook } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAutomationStatus } from '@/hooks/useAutomation';
import { t } from '@/lib/i18n';
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
        <Alert tone="warning" title={account.configured ? t('The automation account key does not work') : t('No automation account is configured')}>
          {t('Rules still notify and call out, but change nothing in OpenProject until there is one.')}{' '}
          {t('Run {script} on the OpenProject container and put the key it prints in {variable}.', {
            script: 'automation-account.rb',
            variable: 'OPENPROJECT_AUTOMATION_API_KEY',
          })}
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 py-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={Bot} title={t('Acts as')}>
            {account.working ? (
              <>
                {account.name}
                <span className="block text-2xs text-muted-foreground">
                  {account.admin ? t('An administrator — not recommended') : t('Not an administrator; added to a project when a rule acts there')}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{t('Nobody yet')}</span>
            )}
          </Fact>
          {show === 'rules' ? (
            <>
              <Fact icon={Activity} title={t('Rule worker')}>
                {worker.enabled ? t('Every {seconds, number} s', { seconds: worker.pollSeconds }) : t('Switched off')}
                <span className="block text-2xs text-muted-foreground">
                  {t('{queued, number} queued · {failed, number} failed this week', { queued: worker.queued, failed: worker.failed })}
                  {worker.lastProcessedAt ? ` · ${t('last {when}', { when: formatRelative(worker.lastProcessedAt) })}` : ''}
                </span>
              </Fact>
              <Fact icon={Webhook} title={t('Changes made in OpenProject')}>
                {webhook.secretConfigured ? t('Arrive by webhook') : t('Not seen: no webhook secret')}
                <span className="block text-2xs text-muted-foreground">
                  {webhook.lastReceivedAt ? t('Last delivery {when}', { when: formatRelative(webhook.lastReceivedAt) }) : t('No delivery since the server started')}
                </span>
              </Fact>
              <Fact icon={Send} title={t('Outbound calls')}>
                {outbound.signing ? t('Signed (X-EPM-Signature)') : t('Not signed')}
                <span className="block text-2xs text-muted-foreground">
                  {outbound.allowlist.length ? t('Also allowed: {hosts}', { hosts: outbound.allowlist.join(', ') }) : t('Public https endpoints only')}
                </span>
              </Fact>
            </>
          ) : (
            <Fact icon={Activity} title={t('Escalation sweep')}>
              {escalation.enabled ? t('Every {minutes, number} min', { minutes: escalation.intervalMinutes }) : t('Switched off')}
              <span className="block text-2xs text-muted-foreground">
                {escalation.lastRunAt ? t('Last ran {when}', { when: formatRelative(escalation.lastRunAt) }) : t('Not run since the server started')}
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
