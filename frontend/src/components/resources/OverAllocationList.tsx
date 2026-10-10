import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, PartyPopper } from 'lucide-react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ProgressBar } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOverAllocations, useResourceRoles } from '@/hooks/useResources';
import { useTeams } from '@/hooks/useTeams';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { OverAllocation } from '@/types';
import { hours } from './bands';

/**
 * Who is asked for more than they have, week by week (BR-110): across every
 * project, against their schedule and time off, with the work and bookings
 * that make up each week — so the conflict is seen before it is committed to.
 */
export function OverAllocationList() {
  const [weeks, setWeeks] = useState(12);
  const [teamId, setTeamId] = useState<string>();
  const [roleId, setRoleId] = useState<string>();
  const over = useOverAllocations({ weeks, teamId, roleId });
  const teams = useTeams();
  const roles = useResourceRoles();

  const byWeek = useMemo(() => {
    const out = new Map<string, OverAllocation[]>();
    for (const entry of over.data ?? []) out.set(entry.week, [...(out.get(entry.week) ?? []), entry]);
    return [...out.entries()];
  }, [over.data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="over-weeks">{t('Weeks ahead')}</Label>
            <Select value={String(weeks)} onValueChange={(value) => setWeeks(Number(value))}>
              <SelectTrigger id="over-weeks" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[4, 8, 12, 26].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-52 space-y-1.5">
            <Label>{t('Team')}</Label>
            <ComboSelect
              label={t('Team')}
              clearable
              placeholder={t('Every team')}
              value={teamId}
              onChange={setTeamId}
              options={(teams.data ?? []).map((team) => ({ id: team.id, name: team.name }))}
            />
          </div>
          <div className="w-52 space-y-1.5">
            <Label>{t('Role')}</Label>
            <ComboSelect
              label={t('Role')}
              clearable
              placeholder={t('Every role')}
              value={roleId}
              onChange={setRoleId}
              options={(roles.data ?? []).map((role) => ({ id: role.id, name: role.name }))}
            />
          </div>
        </CardContent>
      </Card>

      <QueryBoundary
        isLoading={over.isLoading}
        isError={over.isError}
        error={over.error}
        onRetry={() => void over.refetch()}
        errorTitle={t('Over-allocation could not be worked out')}
        skeleton={<ListSkeleton rows={6} />}
        isEmpty={over.data?.length === 0}
        empty={
          <EmptyState
            icon={PartyPopper}
            title={t('Nobody is over-allocated')}
            description={t('In the next {count, plural, one {week} other {# weeks}}, everyone has the hours for what is asked of them.', { count: weeks })}
          />
        }
      >
        <div className="space-y-4" data-testid="over-allocations">
          {byWeek.map(([week, entries]) => (
            <Card key={week}>
              <CardHeader variant="compact">
                <CardTitle>{t('Week of {date}', { date: formatShortDate(week) })}</CardTitle>
                <CardDescription>
                  {t('{count, plural, one {# person} other {# people}} asked for more than they have.', { count: entries.length })}
                </CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border pt-2">
                {entries.map((entry) => (
                  <OverRow key={`${entry.key}:${entry.week}`} entry={entry} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </QueryBoundary>
    </div>
  );
}

function OverRow({ entry }: { entry: OverAllocation }) {
  const [open, setOpen] = useState(false);
  const load = entry.committed + entry.planned;
  return (
    <div className="py-2.5" data-testid="over-allocation">
      <button type="button" className="flex w-full items-center gap-3 text-start" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-medium text-foreground">
            <span className="truncate" dir="auto">
              {entry.name}
            </span>
            {entry.kind === 'placeholder' ? (
              <Badge tone="neutral" size="sm">
                {t('Placeholder')}
              </Badge>
            ) : null}
          </span>
          <span className="mt-1 block">
            <ProgressBar value={Math.min(100, entry.available > 0 ? (entry.available / load) * 100 : 0)} tone="danger" size="sm" />
          </span>
        </span>
        <span className="shrink-0 text-end text-xs tabular-nums">
          <span className="block font-semibold text-danger-strong">{t('{excess} over', { excess: hours(entry.excess) })}</span>
          <span className="block text-2xs text-muted-foreground">
            {t('{load} asked, {available} available', { load: hours(load), available: hours(entry.available) })}
          </span>
        </span>
      </button>
      {open ? (
        <ul className="mt-2 space-y-1 ps-7 text-xs">
          {entry.contributions.map((part) => (
            <li key={part.itemId} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                {part.kind === 'work' ? (
                  <Link to={`/tasks/${part.workPackageId}`} className="text-foreground hover:underline" dir="auto">
                    {part.subject}
                  </Link>
                ) : (
                  <span className="text-foreground">{t('Booked {hours} a week', { hours: hours(part.hoursPerWeek ?? 0) })}</span>
                )}
                <span className="ms-1.5 text-muted-foreground" dir="auto">
                  {part.projectName}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{hours(part.hours)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
