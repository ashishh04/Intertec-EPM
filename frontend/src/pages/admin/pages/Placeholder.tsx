import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { Card } from '@/components/ui/card';
import { t } from '@/lib/i18n';

/**
 * Stand-in for a live administration page that has not been built yet. Each
 * page file in this folder renders this until its real content replaces it.
 */
export function Placeholder({ label }: { label: string }) {
  return (
    <Card>
      <EmptyState
        icon={Construction}
        title={t('{label} — coming next', { label })}
        description={t('This page is being built and will show live data shortly. The route, navigation and data hooks for {label} are in place; the content follows.', { label })}
      />
    </Card>
  );
}
