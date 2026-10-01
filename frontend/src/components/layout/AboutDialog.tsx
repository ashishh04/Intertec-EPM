import { FactList } from '@/components/common/FactList';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useIntegrationStatus } from '@/hooks/useIntegration';
import { useAuth } from '@/providers/AuthProvider';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME, env } from '@/config/env';

/**
 * What this is, and what it is talking to.
 *
 * Small, and worth having: the first question anybody asks when raising a support
 * request is which environment they are on, and the second is whether the delivery
 * system is reachable. Both were only answerable from a page most of the
 * workforce cannot open.
 *
 * The upstream status is read only for people who may see it. For everybody else
 * the row is absent rather than shown as unknown — an integration nobody can
 * inspect is not their problem to diagnose.
 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { can } = useAuth();
  const maySeeIntegration = can('users:manage');

  // Only asked for when the dialog is open and the caller may read it, so
  // opening a help menu does not cost a status probe.
  const integration = useIntegrationStatus({ enabled: open && maySeeIntegration });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {APP_NAME} &mdash; {APP_DESCRIPTOR}
          </DialogTitle>
          <DialogDescription>Built for {ORG_NAME}.</DialogDescription>
        </DialogHeader>

        <FactList
          facts={[
            {
              label: 'Environment',
              mono: false,
              value: (
                <Badge tone="highlight" size="sm" className="capitalize">
                  {env.appEnv}
                </Badge>
              ),
            },
            { label: 'API', value: env.apiBaseUrl },
            ...(maySeeIntegration
              ? [
                  {
                    label: 'Delivery system',
                    mono: false,
                    value: integration.data ? (
                      <Badge
                        tone={
                          integration.data.state === 'connected'
                            ? 'success'
                            : integration.data.state === 'degraded'
                              ? 'warning'
                              : 'danger'
                        }
                        size="sm"
                        dot
                      >
                        {integration.data.state}
                      </Badge>
                    ) : (
                      'Checking…'
                    ),
                  },
                ]
              : []),
          ]}
        />
      </DialogContent>
    </Dialog>
  );
}
