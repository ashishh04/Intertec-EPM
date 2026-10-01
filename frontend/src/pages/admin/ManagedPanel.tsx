import type { ReactNode } from 'react';
import { ExternalLink, Lock } from 'lucide-react';
import { FactList } from '@/components/common/FactList';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface ManagedFact {
  label: string;
  value: ReactNode;
}

interface ManagedPanelProps {
  /** The page label. */
  title: string;
  /** What the setting controls. */
  description: string;
  /** Values EPM can read for this setting, shown as label/value rows. */
  facts?: ManagedFact[];
  /**
   * The feature needs an OpenProject Enterprise licence. Said plainly rather
   * than left to look unfinished — no amount of work here can enable it.
   */
  enterprise?: boolean;
  /**
   * Where the setting is actually changed, as a path through the OpenProject
   * administration — e.g. "Authentication → LDAP connections".
   */
  managedAt?: string;
}

/**
 * A settings panel for something EPM can describe but not change.
 *
 * Every one of these used to render as a title, a sentence and nothing else,
 * which reads exactly like a screen somebody forgot to finish — and was
 * reported as such. A page that cannot act has one job: say why, and say where
 * the thing *is* done. Both are now required to be answerable, so an empty card
 * is no longer a state this can reach.
 *
 * Two different reasons, deliberately not conflated:
 *
 *   `enterprise` — the feature exists but needs a licence this instance does
 *   not hold. Nothing anybody builds here can enable it.
 *
 *   otherwise — the feature is available, and OpenProject simply publishes no
 *   API for it. EPM is not missing a screen; there is nothing to call. Saying
 *   "Enterprise" for one of these, as this did for LDAP, is worse than saying
 *   nothing: it tells an administrator to go and buy something they already have.
 *
 * No link is rendered, only a path. The frontend is never given the upstream
 * URL — see `services/api/client.ts` — and one admin page is not a good enough
 * reason to put it in the page source everywhere else.
 */
export function ManagedPanel({
  title,
  description,
  facts,
  enterprise,
  managedAt,
}: ManagedPanelProps) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 pt-4">
        {enterprise ? (
          <Alert tone="neutral" icon={Lock} title="Needs an Enterprise licence">
            This is part of the OpenProject Enterprise edition, which this instance does not have.
            It cannot be enabled from EPM, and it cannot be enabled in OpenProject either until the
            instance is licensed.
          </Alert>
        ) : (
          <Alert tone="neutral" icon={ExternalLink} title="Changed in OpenProject, not here">
            This setting is available on this instance, but OpenProject publishes no API for it, so
            EPM has nothing to call. It is not missing from EPM — there is nothing for EPM to send.
          </Alert>
        )}

        {managedAt ? (
          <p className="text-xs text-muted-foreground">
            Change it in the OpenProject administration, under{' '}
            <span className="font-medium text-foreground">{managedAt}</span>.
          </p>
        ) : null}

        {facts && facts.length > 0 ? <FactList facts={facts} /> : null}
      </CardContent>
    </Card>
  );
}
