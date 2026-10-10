import { Globe, Lock, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { t } from '@/lib/i18n';
import { periodLabel } from '@/lib/report-periods';
import type { PortfolioView } from '@/types';

/** Who a saved portfolio view is shared with, and what it selects, in a few words (BR-203). */

export function SharingBadge({ view }: { view: Pick<PortfolioView, 'visibility' | 'roles'> }) {
  if (view.visibility === 'public') {
    return (
      <Badge tone="primary" size="sm">
        <Globe className="h-3 w-3" aria-hidden />
        {t('Everyone')}
      </Badge>
    );
  }
  if (view.visibility === 'roles') {
    return (
      <Badge tone="accent" size="sm" title={view.roles.map((role) => role.name).join(t(', '))}>
        <Users className="h-3 w-3" aria-hidden />
        {view.roles.length === 1
          ? view.roles[0]!.name
          : t('{count, plural, one {# role} other {# roles}}', { count: view.roles.length })}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" size="sm">
      <Lock className="h-3 w-3" aria-hidden />
      {t('Only me')}
    </Badge>
  );
}

export function describeSelection(view: Pick<PortfolioView, 'definition'>): string {
  const { portfolioIds, projectIds, health } = view.definition;
  // One whole message per shape of selection, so each reads in its own word order.
  const selection =
    portfolioIds.length === 0 && projectIds.length === 0
      ? t('Every project')
      : portfolioIds.length > 0 && projectIds.length > 0
        ? t(
            '{portfolios, plural, one {# portfolio} other {# portfolios}} and {projects, plural, one {# named project} other {# named projects}}',
            { portfolios: portfolioIds.length, projects: projectIds.length },
          )
        : portfolioIds.length > 0
          ? t('{count, plural, one {# portfolio} other {# portfolios}}', { count: portfolioIds.length })
          : t('{count, plural, one {# named project} other {# named projects}}', { count: projectIds.length });
  const words = { healthy: t('green'), warning: t('amber'), critical: t('red') } as const;
  const levels = health.map((level) => words[level]);
  const filter =
    levels.length === 0
      ? ''
      : ` · ${
          levels.length === 1
            ? t('only {first}', { first: levels[0] })
            : levels.length === 2
              ? t('only {first} or {second}', { first: levels[0], second: levels[1] })
              : t('only {first} or {second} or {third}', { first: levels[0], second: levels[1], third: levels[2] })
        }`;
  return `${selection}${filter} · ${periodLabel(view.definition.periodPreset).toLowerCase()}`;
}
