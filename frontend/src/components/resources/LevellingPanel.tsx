import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, History, Scale, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { MultiSelect, type MultiSelectOption } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useApplyLevelling,
  useDiscardLevelling,
  useLevellingRun,
  useLevellingRuns,
  useProposeLevelling,
  useResourceRoles,
  useUndoLevelling,
} from '@/hooks/useResources';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import { cn, formatDateTime, formatShortDate } from '@/lib/utils';
import type { LevellingMove, LevellingRunView, LevellingStatus, LevellingWeek } from '@/types';
import { hours } from './bands';

const STATUS: Record<LevellingStatus, { tone: Tone; label: () => string }> = {
  proposed: { tone: 'primary', label: () => t('Proposed') },
  applying: { tone: 'warning', label: () => t('Applying') },
  applied: { tone: 'success', label: () => t('Applied') },
  undoing: { tone: 'warning', label: () => t('Undoing') },
  undone: { tone: 'neutral', label: () => t('Undone') },
  discarded: { tone: 'neutral', label: () => t('Discarded') },
  stale: { tone: 'warning', label: () => t('Out of date') },
  failed: { tone: 'danger', label: () => t('Not applied') },
};

const REASON: Record<LevellingMove['reason'], () => string> = {
  capacity: () => t('To fit its assignee'),
  dependency: () => t('After a predecessor that moved'),
  stretched: () => t('Stretched: its hours fit no start at its length'),
};

/**
 * Resource levelling (BR-111, BR-112): propose new dates that resolve
 * over-allocation, see every change before it is made, apply them all or
 * none, and undo them in one step.
 */
export function LevellingPanel() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const setRun = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set('run', id);
        else next.delete('run');
        return next;
      },
      { replace: true },
    );

  return (
    <div className="space-y-4">
      <ProposeForm onProposed={setRun} />
      {runId ? <RunView id={runId} onClose={() => setRun(null)} /> : null}
      <RunHistory selected={runId} onSelect={setRun} />
    </div>
  );
}

function ProposeForm({ onProposed }: { onProposed: (id: string) => void }) {
  const [kind, setKind] = useState<'team' | 'role' | 'people'>('team');
  const [teamId, setTeamId] = useState<string>();
  const [roleId, setRoleId] = useState<string>();
  const [people, setPeople] = useState<MultiSelectOption[]>([]);
  const [keepManual, setKeepManual] = useState(false);
  const [horizonWeeks, setHorizonWeeks] = useState(26);
  const teams = useTeams();
  const roles = useResourceRoles();
  const users = useUsers();
  const propose = useProposeLevelling();

  const ready = kind === 'team' ? Boolean(teamId) : kind === 'role' ? Boolean(roleId) : people.length > 0;
  const submit = () => {
    const scope = kind === 'team' ? { kind, id: teamId } : kind === 'role' ? { kind, id: roleId } : { kind, people: people.map((person) => person.id) };
    propose.mutate(
      { scope, keepManual, horizonWeeks },
      {
        onSuccess: (run) => {
          onProposed(run.id);
          toast.success(
            run.moves.length === 0
              ? t('Nothing to move')
              : t('{count, plural, one {# move} other {# moves}} proposed', { count: run.moves.length }),
            { description: t('Nothing has changed yet: check the proposal, then apply it.') },
          );
        },
        onError: (error) => toast.error(t('Levelling could not be worked out'), { description: error instanceof Error ? error.message : undefined }),
      },
    );
  };

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Level a team, a role or named people')}</CardTitle>
        <CardDescription>
          {t(
            'Proposes later dates for work that over-allocates its assignee, keeping every dependency. It never moves pinned work, work already under way, or work you may not edit — and it only proposes: nothing changes until you apply it.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3 pt-4">
        <div className="space-y-1.5">
          <Label htmlFor="level-kind">{t('Level')}</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
            <SelectTrigger id="level-kind" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="team">{t('A team')}</SelectItem>
              <SelectItem value="role">{t('A role')}</SelectItem>
              <SelectItem value="people">{t('Named people')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {kind === 'team' ? (
          <div className="w-56 space-y-1.5">
            <Label>{t('Team')}</Label>
            <ComboSelect label={t('Team')} value={teamId} onChange={setTeamId} options={(teams.data ?? []).map((team) => ({ id: team.id, name: team.name }))} />
          </div>
        ) : kind === 'role' ? (
          <div className="w-56 space-y-1.5">
            <Label>{t('Role')}</Label>
            <ComboSelect label={t('Role')} value={roleId} onChange={setRoleId} options={(roles.data ?? []).map((role) => ({ id: role.id, name: role.name }))} />
          </div>
        ) : (
          <div className="w-72 space-y-1.5">
            <Label>{t('People')}</Label>
            <MultiSelect
              label={t('People')}
              options={(users.data ?? []).map((user) => ({ id: user.id, name: user.name }))}
              selected={people}
              onChange={setPeople}
              placeholder={t('Choose people')}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="level-horizon">{t('Push at most')}</Label>
          <Select value={String(horizonWeeks)} onValueChange={(value) => setHorizonWeeks(Number(value))}>
            <SelectTrigger id="level-horizon" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[13, 26, 52].map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {t('{count} weeks', { count })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex max-w-xs items-center gap-2 pb-2 text-xs text-foreground">
          <Switch checked={keepManual} onCheckedChange={setKeepManual} aria-label={t('Keep manually scheduled work where it is')} />
          {t('Keep manually scheduled work where it is')}
        </label>
        <Button className="ms-auto" disabled={!ready} loading={propose.isPending} onClick={submit}>
          <Scale className="h-4 w-4" />
          {t('Propose')}
        </Button>
      </CardContent>
    </Card>
  );
}

function RunView({ id, onClose }: { id: string; onClose: () => void }) {
  const run = useLevellingRun(id);
  const users = useUserMap();
  const apply = useApplyLevelling();
  const undo = useUndoLevelling();
  const discard = useDiscardLevelling();
  const [confirm, setConfirm] = useState<'apply' | 'undo' | null>(null);
  const data = run.data;

  const act = (action: 'apply' | 'undo' | 'discard') => {
    const mutation = action === 'apply' ? apply : action === 'undo' ? undo : discard;
    mutation.mutate(id, {
      onSuccess: () => {
        setConfirm(null);
        void run.refetch();
        toast.success(
          action === 'apply' ? t('Levelling applied') : action === 'undo' ? t('Levelling undone: every date is as it was') : t('Proposal discarded'),
        );
      },
      onError: (error) => {
        setConfirm(null);
        void run.refetch();
        toast.error(action === 'undo' ? t('The undo did not go ahead') : t('Levelling was not applied'), {
          description: error instanceof Error ? error.message : undefined,
        });
      },
    });
  };

  return (
    <QueryBoundary
      isLoading={run.isLoading}
      isError={run.isError}
      error={run.error}
      onRetry={() => void run.refetch()}
      errorTitle={t('This levelling run could not be loaded')}
      skeleton={<ListSkeleton rows={6} />}
    >
      {data ? (
        <Card data-testid="levelling-run">
          <CardHeader variant="compact">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <span dir="auto">{t('Levelling {scope}', { scope: data.scope.name })}</span>
                  <Badge tone={STATUS[data.status].tone} size="sm">
                    {STATUS[data.status].label()}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {t('Proposed {when} by {who}', { when: formatDateTime(data.createdAt), who: users.get(data.createdBy)?.name ?? t('someone') })}
                  {data.appliedAt ? ` · ${t('applied {when}', { when: formatDateTime(data.appliedAt) })}` : ''}
                  {data.undoneAt ? ` · ${t('undone {when}', { when: formatDateTime(data.undoneAt) })}` : ''}
                </CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {data.status === 'proposed' ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => act('discard')} loading={discard.isPending}>
                      {t('Discard')}
                    </Button>
                    {data.moves.length > 0 ? (
                      <Button size="sm" onClick={() => setConfirm('apply')}>
                        {t('Apply {count, plural, one {# move} other {# moves}}', { count: data.moves.length })}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {data.status === 'applied' ? (
                  <Button size="sm" variant="secondary" onClick={() => setConfirm('undo')}>
                    <Undo2 className="h-4 w-4" />
                    {t('Undo')}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={onClose}>
                  {t('Close')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-4">
            {data.error ? <Alert tone={data.status === 'applied' ? 'warning' : 'danger'} title={t('What happened')}>{data.error}</Alert> : null}

            <dl className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
              <Summary label={t('Moves')} value={String(data.moves.length)} />
              <Summary label={t('Over-allocated weeks before')} value={String(data.before.length)} tone={data.before.length > 0 ? 'danger' : undefined} />
              <Summary label={t('Over-allocated weeks after')} value={String(data.after.length)} tone={data.after.length > 0 ? 'warning' : 'success'} />
              <Summary label={t('People')} value={String(data.scope.people)} />
            </dl>

            <FixedNote run={data} />

            {data.conflicts.length > 0 ? (
              <Alert tone="warning" title={t('Could not be resolved')}>
                <ul className="list-inside list-disc">
                  {data.conflicts.map((conflict) => (
                    <li key={conflict.workPackageId}>
                      <Link to={`/tasks/${conflict.workPackageId}`} className="hover:underline" dir="auto">
                        {conflict.subject}
                      </Link>{' '}
                      —{' '}
                      {conflict.reason === 'pinned'
                        ? t('it cannot fit before pinned work that follows it, so it stays where it is.')
                        : t('there is no room for it within the weeks it may be pushed.')}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {data.moves.length > 0 ? <MovesTable moves={data.moves} /> : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <WeeksList title={t('Over-allocated before')} weeks={data.before} empty={t('Nobody was over-allocated.')} />
              <WeeksList title={t('Over-allocated after')} weeks={data.after} empty={t('Nobody is over-allocated once this is applied.')} />
            </div>
          </CardContent>

          <ConfirmDialog
            open={confirm === 'apply'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('Apply this levelling?')}
            description={t(
              'Every move is made, or none is: if any work has changed since the proposal, or a single write is refused, nothing changes. Work that is scheduled automatically is switched to manual scheduling so it keeps its new dates. One undo puts everything back.',
            )}
            confirmLabel={t('Apply')}
            pending={apply.isPending}
            onConfirm={() => act('apply')}
          />
          <ConfirmDialog
            open={confirm === 'undo'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('Undo this levelling?')}
            description={t(
              'Every work package goes back to its dates and scheduling mode from before. It does not go ahead if any of them has been changed since, so no one’s later change is overwritten.',
            )}
            confirmLabel={t('Undo')}
            pending={undo.isPending}
            onConfirm={() => act('undo')}
          />
        </Card>
      ) : null}
    </QueryBoundary>
  );
}

function FixedNote({ run }: { run: LevellingRunView }) {
  const { pinned, started, manual, parent, notEditable } = run.fixed;
  const total = pinned + started + manual + parent + notEditable;
  if (total === 0) return null;
  const parts = [
    pinned ? t('{count} pinned', { count: pinned }) : null,
    started ? t('{count} already under way', { count: started }) : null,
    manual ? t('{count} manually scheduled', { count: manual }) : null,
    parent ? t('{count} parents, which follow their children', { count: parent }) : null,
    notEditable ? t('{count} you may not edit', { count: notEditable }) : null,
  ].filter(Boolean);
  return (
    <p className="text-xs text-muted-foreground">
      {t('Left where they are: {parts}.', { parts: parts.join(', ') })}{' '}
      {run.after.length > 0 ? t('Over-allocation that remains comes from work levelling does not move.') : ''}
    </p>
  );
}

/** Each move as two bars on one scale: where it was, and where it goes. */
function MovesTable({ moves }: { moves: LevellingMove[] }) {
  const scale = useMemo(() => {
    const days = moves.flatMap((move) => [move.beforeStart, move.beforeDue, move.afterStart, move.afterDue]).map((day) => Date.parse(`${day}T00:00:00Z`));
    const first = Math.min(...days);
    const last = Math.max(...days);
    return { first, span: Math.max(last - first + 86_400_000, 86_400_000) };
  }, [moves]);
  const bar = (start: string, due: string) => {
    const from = Date.parse(`${start}T00:00:00Z`);
    const to = Date.parse(`${due}T00:00:00Z`) + 86_400_000;
    return { insetInlineStart: `${((from - scale.first) / scale.span) * 100}%`, width: `${Math.max(((to - from) / scale.span) * 100, 1.5)}%` };
  };
  return (
    <Table data-testid="levelling-moves">
      <TableHeader>
        <TableRow>
          <TableHead>{t('Work package')}</TableHead>
          <TableHead>{t('Assignee')}</TableHead>
          <TableHead numeric>{t('Hours')}</TableHead>
          <TableHead>{t('Before → after')}</TableHead>
          <TableHead className="w-48">{t('On one scale')}</TableHead>
          <TableHead>{t('Why')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {moves.map((move) => (
          <TableRow key={move.workPackageId} data-state={move.state}>
            <TableCell>
              <Link to={`/tasks/${move.workPackageId}`} className="font-medium text-foreground hover:underline" dir="auto">
                {move.subject}
              </Link>
              <span className="block text-2xs text-muted-foreground" dir="auto">
                {move.projectName}
              </span>
            </TableCell>
            <TableCell dir="auto">{move.assigneeName ?? '—'}</TableCell>
            <TableCell numeric>{hours(move.hours)}</TableCell>
            <TableCell className="whitespace-nowrap text-xs tabular-nums">
              <span className="text-muted-foreground line-through">
                {formatShortDate(move.beforeStart)} – {formatShortDate(move.beforeDue)}
              </span>
              <ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="font-medium text-foreground">
                {formatShortDate(move.afterStart)} – {formatShortDate(move.afterDue)}
              </span>
              <span className="block text-2xs text-muted-foreground">
                {t('{count, plural, one {# working day} other {# working days}} later', { count: move.shiftDays })}
                {!move.beforeManual ? ` · ${t('switched to manual scheduling')}` : ''}
              </span>
            </TableCell>
            <TableCell>
              <div className="relative h-6" aria-hidden>
                <span className="absolute top-0.5 h-2 rounded-sm bg-neutral/40" style={bar(move.beforeStart, move.beforeDue)} />
                <span className="absolute bottom-0.5 h-2 rounded-sm bg-primary" style={bar(move.afterStart, move.afterDue)} />
              </div>
            </TableCell>
            <TableCell className="text-xs">{REASON[move.reason]()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WeeksList({ title, weeks, empty }: { title: string; weeks: LevellingWeek[]; empty: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      {weeks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {weeks.slice(0, 20).map((week) => (
            <li key={`${week.key}:${week.week}`} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate" dir="auto">
                {week.name} · {formatShortDate(week.week)}
              </span>
              <span className="shrink-0 tabular-nums text-danger-strong">
                {t('{load} of {available}', { load: hours(week.load), available: hours(week.available) })}
              </span>
            </li>
          ))}
          {weeks.length > 20 ? (
            <li className="px-3 py-1.5 text-muted-foreground">{t('and {count} more', { count: weeks.length - 20 })}</li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger-strong' : tone === 'warning' ? 'text-warning-strong' : tone === 'success' ? 'text-success-strong' : 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function RunHistory({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const runs = useLevellingRuns();
  const users = useUserMap();
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Levelling runs')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        <QueryBoundary
          isLoading={runs.isLoading}
          isError={runs.isError}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          skeleton={<ListSkeleton rows={3} />}
          isEmpty={runs.data?.length === 0}
          empty={<EmptyState icon={Scale} title={t('No levelling yet')} description={t('Proposals and what became of them appear here.')} />}
        >
          <ul className="divide-y divide-border text-xs" data-testid="levelling-runs">
            {(runs.data ?? []).map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-start hover:bg-muted/50', selected === run.id && 'bg-muted/60')}
                >
                  <Badge tone={STATUS[run.status].tone} size="sm">
                    {STATUS[run.status].label()}
                  </Badge>
                  <span className="font-medium text-foreground" dir="auto">
                    {run.scopeName}
                  </span>
                  <span className="text-muted-foreground">
                    {t('{count, plural, one {# move} other {# moves}}', { count: run.moves })} ·{' '}
                    {t('over-allocated weeks {before} → {after}', { before: run.overBefore, after: run.overAfter })}
                  </span>
                  <span className="ms-auto text-muted-foreground">
                    {formatDateTime(run.createdAt)} · {users.get(run.createdBy)?.name ?? ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
