import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronDown, Flag, Map as MapIcon } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useRoadmap } from '@/hooks/useProjectSettings';
import { useUserMap } from '@/hooks/useUsers';
import { cn, formatPercent, formatShortDate } from '@/lib/utils';
import { formatLocalNumber, t } from '@/lib/i18n';
import type { RoadmapVersion } from '@/types';

/**
 * The project's roadmap: its versions (sprints and releases), soonest first
 * and closed last, each with how much of the work planned into it is done,
 * in work packages and in points, and the work itself a click away.
 */
export default function ProjectRoadmapTab() {
  const { projectId } = useParams();
  const roadmap = useRoadmap(projectId);
  const users = useUserMap();
  const versions = roadmap.data ?? [];

  return (
    <QueryBoundary
      isLoading={roadmap.isLoading}
      isError={roadmap.isError}
      error={roadmap.error}
      onRetry={() => roadmap.refetch()}
      errorTitle={t('Unable to load the roadmap')}
      skeleton={<Skeleton className="h-64 w-full rounded-lg" />}
      isEmpty={versions.length === 0}
      empty={
        <Card>
          <EmptyState
            icon={MapIcon}
            title={t('No versions yet')}
            description={t('The roadmap lists the project’s sprints and releases with the work planned into each. Create a sprint to start one.')}
          />
        </Card>
      }
    >
      <ol className="space-y-3">
        {versions.map((version) => (
          <VersionCard key={version.id} version={version} users={users} />
        ))}
      </ol>
    </QueryBoundary>
  );
}

function VersionCard({ version, users }: { version: RoadmapVersion; users: ReturnType<typeof useUserMap> }) {
  const [open, setOpen] = useState(version.status !== 'closed' && version.total > 0 && version.total <= 12);
  const done = version.total > 0 ? Math.round((version.closed / version.total) * 100) : 0;
  const late = version.status !== 'closed' && version.endDate !== undefined && version.endDate < new Date().toISOString().slice(0, 10);

  return (
    <li>
      <Card className={cn('p-4', version.status === 'closed' && 'opacity-80')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Flag className="h-4 w-4 text-primary" aria-hidden />
              <h3 className="text-sm font-semibold" dir="auto">
                {version.name}
              </h3>
              <Badge tone={version.status === 'closed' ? 'neutral' : version.status === 'locked' ? 'warning' : 'success'} size="sm">
                {version.status === 'closed' ? t('Closed') : version.status === 'locked' ? t('Locked') : t('Open')}
              </Badge>
              {late ? (
                <Badge tone="danger" size="sm">
                  {t('Past its end date')}
                </Badge>
              ) : null}
              {version.definingProjectName ? (
                <Badge tone="accent" size="sm">
                  {t('Shared from {project}', { project: version.definingProjectName })}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
              {version.startDate || version.endDate
                ? `${formatShortDate(version.startDate)} — ${formatShortDate(version.endDate)}`
                : t('No dates')}
            </p>
            {version.description ? (
              <p className="mt-1 text-xs text-muted-foreground" dir="auto">
                {version.description}
              </p>
            ) : null}
          </div>
          <dl className="flex gap-5 text-end text-xs">
            <div>
              <dt className="epm-eyebrow">{t('Done')}</dt>
              <dd className="font-mono font-semibold tabular-nums">{formatPercent(done)}</dd>
            </div>
            <div>
              <dt className="epm-eyebrow">{t('Work packages')}</dt>
              <dd className="font-mono font-semibold tabular-nums">
                {formatLocalNumber(version.closed)}/{formatLocalNumber(version.total)}
              </dd>
            </div>
            <div>
              <dt className="epm-eyebrow">{t('Points')}</dt>
              <dd className="font-mono font-semibold tabular-nums">
                {formatLocalNumber(version.pointsDone)}/{formatLocalNumber(version.pointsTotal)}
              </dd>
            </div>
          </dl>
        </div>

        <ProgressBar value={done} size="sm" className="mt-3" label={t('{name} progress', { name: version.name })} />

        {version.total > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90 rtl:rotate-90')} aria-hidden />
              {open
                ? t('Hide the work')
                : t('{count, plural, one {Show # work package} other {Show # work packages}}', { count: version.total })}
            </button>
            {open ? (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {version.items.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <TypeBadge type={task.type} label={task.typeRef.name} />
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">{task.key}</span>
                    <Link to={`/tasks/${task.id}`} className={cn('min-w-0 flex-1 truncate hover:text-primary', task.status.isClosed && 'text-muted-foreground line-through')} dir="auto">
                      {task.subject}
                    </Link>
                    {task.storyPoints ? <span className="shrink-0 font-mono text-2xs text-muted-foreground">{t('{points, number} pts', { points: task.storyPoints })}</span> : null}
                    <StatusBadge status={task.statusCategory} label={task.status.name} size="sm" />
                    <UserAvatarWithTooltip user={task.assigneeId ? users.get(task.assigneeId) : undefined} size="xs" />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-2xs text-muted-foreground">{t('No work is planned into it yet.')}</p>
        )}
      </Card>
    </li>
  );
}
