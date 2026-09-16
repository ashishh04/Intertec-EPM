import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { Card } from '@/components/ui/card';

/**
 * Stand-in for a live administration page that has not been built yet. Each
 * page file in this folder renders this until its real content replaces it.
 */
export function Placeholder({ label }: { label: string }) {
  return (
    <Card>
      <EmptyState
        icon={Construction}
        title={`${label} — coming next`}
        description={`This page is being built and will show live data shortly. The route, navigation and data hooks for ${label} are in place; the content follows.`}
      />
    </Card>
  );
}
