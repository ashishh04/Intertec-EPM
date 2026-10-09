import { Globe, Lock, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { periodLabel } from '@/lib/report-periods';
import { pluralize } from '@/lib/utils';
import type { PortfolioView } from '@/types';

/** Who a saved portfolio view is shared with, and what it selects, in a few words (BR-203). */

export function SharingBadge({ view }: { view: Pick<PortfolioView, 'visibility' | 'roles'> }) {
  if (view.visibility === 'public') {
    return (
      <Badge tone="primary" size="sm">
        <Globe className="h-3 w-3" aria-hidden />
        Everyone
      </Badge>
    );
  }
  if (view.visibility === 'roles') {
    return (
      <Badge tone="accent" size="sm" title={view.roles.map((role) => role.name).join(', ')}>
        <Users className="h-3 w-3" aria-hidden />
        {view.roles.length === 1 ? view.roles[0]!.name : `${view.roles.length} roles`}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" size="sm">
      <Lock className="h-3 w-3" aria-hidden />
      Only me
    </Badge>
  );
}

export function describeSelection(view: Pick<PortfolioView, 'definition'>): string {
  const { portfolioIds, projectIds, health } = view.definition;
  const parts: string[] = [];
  if (portfolioIds.length === 0 && projectIds.length === 0) parts.push('Every project');
  if (portfolioIds.length > 0) parts.push(`${portfolioIds.length} ${pluralize(portfolioIds.length, 'portfolio')}`);
  if (projectIds.length > 0) parts.push(`${projectIds.length} ${pluralize(projectIds.length, 'named project')}`);
  const words = { healthy: 'green', warning: 'amber', critical: 'red' } as const;
  const filter = health.length > 0 ? ` · only ${health.map((level) => words[level]).join(' or ')}` : '';
  return `${parts.join(' and ')}${filter} · ${periodLabel(view.definition.periodPreset).toLowerCase()}`;
}
