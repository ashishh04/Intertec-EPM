import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
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
}

/**
 * A plain settings panel: the setting's name, what it controls, and any values
 * EPM can read for it.
 */
export function ManagedPanel({ title, description, facts, enterprise }: ManagedPanelProps) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {enterprise ? (
        <CardContent className="pt-4">
          <Alert tone="neutral" icon={Lock}>
            This feature is part of the OpenProject Enterprise edition, which this instance does
            not have. It cannot be enabled from EPM — it needs a licence.
          </Alert>
        </CardContent>
      ) : null}

      {facts && facts.length > 0 ? (
        <CardContent className={enterprise ? undefined : 'pt-4'}>
          <FactList facts={facts} />
        </CardContent>
      ) : null}
    </Card>
  );
}
