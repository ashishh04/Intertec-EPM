import { Link } from 'react-router-dom';
import { Archive, Briefcase, RotateCcw, ShieldAlert, Trash2, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DeliveryProgress, HealthBar } from './PortfolioVisuals';
import { cn, formatNumber, pluralize } from '@/lib/utils';
import type { EpmPortfolio } from '@/services/api/portfolios';

/**
 * One portfolio in the directory.
 *
 * A tile rather than the single-line row this replaced: the row had room for
 * counts but not for the shape behind them, so two portfolios with the same
 * project count looked identical whatever state their work was in. Everything
 * drawn here is rolled up live from the projects the reader can already see.
 *
 * The whole tile is not one link — it carries archive and delete buttons, which
 * cannot be nested inside an anchor — so the name is the link and the rest is
 * static.
 */

interface PortfolioCardProps {
  portfolio: EpmPortfolio;
  mayManage: boolean;
  onEdit: (portfolio: EpmPortfolio) => void;
  onToggleActive: (portfolio: EpmPortfolio) => void;
  onRemove: (portfolio: EpmPortfolio) => void;
}

export function PortfolioCard({
  portfolio,
  mayManage,
  onEdit,
  onToggleActive,
  onRemove,
}: PortfolioCardProps) {
  return (
    <Card
      className={cn(
        'group relative flex h-full flex-col gap-4 p-4 transition-colors hover:border-primary/40',
        portfolio.active ? null : 'bg-muted/40',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* The name is the only anchor, stretched over the whole tile by
                the pseudo-element below. Nesting the tile in an anchor instead
                would put the archive and delete buttons inside a link, which is
                invalid and breaks keyboard activation; this way the card is one
                large target and there is still exactly one link to tab to. */}
            <Link
              to={`/portfolios/${portfolio.id}`}
              className="truncate rounded-sm text-sm font-semibold tracking-tight transition-colors after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {portfolio.name}
            </Link>
            <Badge size="sm" className="font-mono">
              {portfolio.code}
            </Badge>
            {portfolio.active ? null : (
              <Badge tone="warning" size="sm">
                Archived
              </Badge>
            )}
          </div>

          {portfolio.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {portfolio.description}
            </p>
          ) : null}
        </div>

        {mayManage ? (
          // Above the stretched link, or the overlay would swallow these clicks.
          <div className="relative z-10 flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={portfolio.active ? `Archive ${portfolio.name}` : `Restore ${portfolio.name}`}
              onClick={() => onToggleActive(portfolio)}
            >
              {portfolio.active ? (
                <Archive className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${portfolio.name}`}
              className="hover:bg-danger-soft hover:text-danger"
              onClick={() => onRemove(portfolio)}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <p className="epm-eyebrow mb-1.5">Delivery</p>
        <DeliveryProgress
          completed={portfolio.completedTaskCount}
          total={portfolio.taskCount}
        />
      </div>

      <div>
        <p className="epm-eyebrow mb-1.5">Project health</p>
        {portfolio.projectCount === 0 ? (
          <p className="text-xs text-muted-foreground">No projects in this portfolio yet.</p>
        ) : (
          <HealthBar health={portfolio.health} />
        )}
      </div>

      {/* Pushed to the bottom so tiles in a row line their footers up even when
          descriptions run to different lengths. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-2xs text-muted-foreground">
        <span className="tabular-nums">
          <span className="font-mono text-foreground">
            {formatNumber(portfolio.activeProjectCount)}
          </span>
          {' of '}
          <span className="font-mono text-foreground">{formatNumber(portfolio.projectCount)}</span>
          {' '}
          {pluralize(portfolio.projectCount, 'project')} active
        </span>

        <span className="flex items-center gap-1 tabular-nums">
          <Users className="h-3 w-3" aria-hidden />
          <span className="font-mono text-foreground">{formatNumber(portfolio.memberCount)}</span>
          {' · '}
          <span className="font-mono text-foreground">
            {formatNumber(portfolio.capacityHours)}
          </span>
          {' h/wk'}
        </span>

        {portfolio.openRiskCount > 0 ? (
          <span className="flex items-center gap-1 tabular-nums text-danger">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            <span className="font-mono">{formatNumber(portfolio.openRiskCount)}</span>
            {' '}
            {pluralize(portfolio.openRiskCount, 'risk')}
          </span>
        ) : null}
      </div>

      {portfolio.teams.length > 0 ? (
        <p className="-mt-1 truncate text-2xs text-muted-foreground">
          Teams: {portfolio.teams.map((team) => team.name).join(', ')}
        </p>
      ) : null}

      {mayManage ? (
        <Button
          variant="secondary"
          size="sm"
          className="relative z-10 w-full"
          onClick={() => onEdit(portfolio)}
        >
          Edit details
        </Button>
      ) : null}
    </Card>
  );
}

export function PortfolioCardSkeleton() {
  return (
    <Card className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
      <Skeleton className="h-2 w-full rounded-full" />
      <Skeleton className="h-2 w-full rounded-full" />
      <Skeleton className="h-3 w-2/3" />
    </Card>
  );
}
