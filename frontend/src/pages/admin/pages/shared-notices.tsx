import { Server } from 'lucide-react';
import { Alert } from '@/components/ui/alert';

/**
 * Notices more than one administration page shows, built on the product's
 * `Alert` so they read as a family rather than as hand-built boxes.
 */

/**
 * Shown once the instance has refused a calendar write because its version
 * does not offer it through the API. The page keeps its controls, because a
 * newer instance accepts the same request; this explains why this one did not.
 */
export function ManagedUpstreamNotice({
  shown,
}: {
  /** What the page is displaying, so the closing sentence fits: "The list shown is current." */
  shown: 'list' | 'values';
}) {
  return (
    <Alert tone="neutral" icon={Server} title="This calendar cannot be changed from EPM on this instance">
      The delivery system's version does not offer this change through its API. The {shown} shown{' '}
      {shown === 'list' ? 'is' : 'are'} current.
    </Alert>
  );
}
