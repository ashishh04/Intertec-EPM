import { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Building2,
  ChevronRight,
  Ellipsis,
  Pencil,
  Plus,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { DepartmentDialog } from '@/components/departments/DepartmentDialog';
import { MappingDialog } from '@/components/employees/MappingDialog';
import { TeamDialog } from '@/components/teams/TeamDialog';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDeleteDepartment, useDepartments } from '@/hooks/useDepartments';
import { useEmployees, useSetMapping } from '@/hooks/useEmployees';
import { usePagination } from '@/hooks/usePagination';
import { useDeleteTeam, useTeams, useUpdateTeam } from '@/hooks/useTeams';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmDepartment } from '@/services/api/departments';
import type { EpmEmployee } from '@/services/api/employees';
import type { EpmTeam } from '@/services/api/teams';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

/**
 * Organization: the company's structure in one place — departments, the
 * teams inside them, and who sits where.
 *
 * Laid out as the instance's own organisation page is: the hierarchy on one
 * side, and for whatever is chosen there its sub-units and its people on the
 * other. Everything here is EPM's own data — the same departments, teams and
 * employee mapping the People pages edit, through the same hooks and dialogs,
 * so the two can never disagree. A person belongs to one department and at
 * most one team; placing them somewhere else moves them.
 */

type Selection =
  | { kind: 'organization' }
  | { kind: 'department'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'unplaced' };

const NO_DEPARTMENT = '__none__';
const PEOPLE_PAGE_SIZE = 25;

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (!id) continue;
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
}

export default function OrganizationPage() {
  const { can } = useAuth();
  const mayDepartments = can('departments:manage');
  const mayTeams = can('teams:manage');
  const mayPeople = can('employees:manage');

  const departments = useDepartments(true);
  const teams = useTeams({ includeInactive: true });
  const employees = useEmployees();

  const [selection, setSelection] = useState<Selection>({ kind: 'organization' });

  const departmentList = useMemo(() => [...(departments.data ?? [])].sort(byName), [departments.data]);
  const teamList = useMemo(() => [...(teams.data ?? [])].sort(byName), [teams.data]);
  const people = useMemo(() => [...(employees.data ?? [])].sort(byName), [employees.data]);

  const teamsByDepartment = useMemo(
    () => groupBy(teamList, (team) => team.department?.id ?? NO_DEPARTMENT),
    [teamList],
  );
  const peopleByDepartment = useMemo(() => groupBy(people, (person) => person.department?.id), [people]);
  const peopleByTeam = useMemo(() => groupBy(people, (person) => person.team?.id), [people]);
  const unplaced = useMemo(() => people.filter((person) => !person.department && !person.team), [people]);

  // A unit deleted elsewhere, or by this page, leaves nothing to show.
  const department =
    selection.kind === 'department' ? departmentList.find((item) => item.id === selection.id) : undefined;
  const team = selection.kind === 'team' ? teamList.find((item) => item.id === selection.id) : undefined;
  const current: Selection =
    (selection.kind === 'department' && !department) || (selection.kind === 'team' && !team)
      ? { kind: 'organization' }
      : selection;

  const loading = departments.isLoading || teams.isLoading || employees.isLoading;
  const failed = departments.isError ? departments : teams.isError ? teams : employees.isError ? employees : undefined;

  return (
    <QueryBoundary
      isLoading={loading}
      isError={Boolean(failed)}
      error={failed?.error}
      onRetry={() => {
        void departments.refetch();
        void teams.refetch();
        void employees.refetch();
      }}
      errorTitle={t('The organisation could not be loaded')}
      skeleton={<ListSkeleton rows={6} height="h-12" />}
    >
      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Hierarchy
          departments={departmentList}
          teamsByDepartment={teamsByDepartment}
          peopleByDepartment={peopleByDepartment}
          peopleByTeam={peopleByTeam}
          peopleCount={people.length}
          unplacedCount={unplaced.length}
          selection={current}
          onSelect={setSelection}
        />

        <div className="min-w-0">
          {current.kind === 'department' && department ? (
            <DepartmentDetail
              department={department}
              teams={teamsByDepartment.get(department.id) ?? []}
              people={peopleByDepartment.get(department.id) ?? []}
              allPeople={people}
              peopleByTeam={peopleByTeam}
              mayDepartments={mayDepartments}
              mayTeams={mayTeams}
              mayPeople={mayPeople}
              departments={departmentList}
              onSelect={setSelection}
            />
          ) : current.kind === 'team' && team ? (
            <TeamDetail
              team={team}
              people={peopleByTeam.get(team.id) ?? []}
              allPeople={people}
              mayTeams={mayTeams}
              mayPeople={mayPeople}
              departments={departmentList}
              onSelect={setSelection}
            />
          ) : current.kind === 'unplaced' ? (
            <UnplacedDetail people={unplaced} mayPeople={mayPeople} />
          ) : (
            <OrganizationDetail
              departments={departmentList}
              teamsWithoutDepartment={teamsByDepartment.get(NO_DEPARTMENT) ?? []}
              teamsByDepartment={teamsByDepartment}
              peopleByDepartment={peopleByDepartment}
              peopleByTeam={peopleByTeam}
              peopleCount={people.length}
              unplacedCount={unplaced.length}
              mayDepartments={mayDepartments}
              mayTeams={mayTeams}
              onSelect={setSelection}
            />
          )}
        </div>
      </div>
    </QueryBoundary>
  );
}

/* ------------------------------------------------------------------------ */
/* The hierarchy                                                             */
/* ------------------------------------------------------------------------ */

function Hierarchy({
  departments,
  teamsByDepartment,
  peopleByDepartment,
  peopleByTeam,
  peopleCount,
  unplacedCount,
  selection,
  onSelect,
}: {
  departments: EpmDepartment[];
  teamsByDepartment: Map<string, EpmTeam[]>;
  peopleByDepartment: Map<string, EpmEmployee[]>;
  peopleByTeam: Map<string, EpmEmployee[]>;
  peopleCount: number;
  unplacedCount: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const isSelected = (candidate: Selection) =>
    candidate.kind === selection.kind &&
    ('id' in candidate ? 'id' in selection && candidate.id === selection.id : true);

  const loose = teamsByDepartment.get(NO_DEPARTMENT) ?? [];

  return (
    <Card className="lg:sticky lg:top-4">
      <CardContent className="p-2">
        <nav aria-label={t('Organisation structure')}>
          <ul className="space-y-0.5">
            <li>
              <Node
                icon={Building2}
                label={t('Organization')}
                count={peopleCount}
                selected={isSelected({ kind: 'organization' })}
                onClick={() => onSelect({ kind: 'organization' })}
                strong
              />
              <ul className="mt-0.5 space-y-0.5 ps-3">
                {departments.map((department) => (
                  <li key={department.id}>
                    <Node
                      icon={UsersRound}
                      label={department.name}
                      count={peopleByDepartment.get(department.id)?.length ?? 0}
                      muted={!department.active}
                      selected={isSelected({ kind: 'department', id: department.id })}
                      onClick={() => onSelect({ kind: 'department', id: department.id })}
                    />
                    {(teamsByDepartment.get(department.id) ?? []).length > 0 ? (
                      <ul className="mt-0.5 space-y-0.5 ps-4">
                        {(teamsByDepartment.get(department.id) ?? []).map((team) => (
                          <li key={team.id}>
                            <Node
                              icon={Users}
                              label={team.name}
                              count={peopleByTeam.get(team.id)?.length ?? 0}
                              muted={!team.active}
                              selected={isSelected({ kind: 'team', id: team.id })}
                              onClick={() => onSelect({ kind: 'team', id: team.id })}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
                {loose.map((team) => (
                  <li key={team.id}>
                    <Node
                      icon={Users}
                      label={team.name}
                      hint={t('No department')}
                      count={peopleByTeam.get(team.id)?.length ?? 0}
                      muted={!team.active}
                      selected={isSelected({ kind: 'team', id: team.id })}
                      onClick={() => onSelect({ kind: 'team', id: team.id })}
                    />
                  </li>
                ))}
              </ul>
            </li>
            <li className="border-t border-border pt-1">
              <Node
                icon={UserMinus}
                label={t('Not placed')}
                count={unplacedCount}
                selected={isSelected({ kind: 'unplaced' })}
                onClick={() => onSelect({ kind: 'unplaced' })}
              />
            </li>
          </ul>
        </nav>
      </CardContent>
    </Card>
  );
}

function Node({
  icon: Icon,
  label,
  hint,
  count,
  selected,
  muted,
  strong,
  onClick,
}: {
  icon: typeof Building2;
  label: string;
  hint?: string;
  count: number;
  selected: boolean;
  muted?: boolean;
  strong?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-primary-soft text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        strong && 'font-semibold',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', selected && 'text-primary')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', muted && 'opacity-60')} dir="auto">
        {label}
        {hint ? <span className="ms-1 text-2xs text-muted-foreground">· {hint}</span> : null}
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* The organisation as a whole                                               */
/* ------------------------------------------------------------------------ */

function OrganizationDetail({
  departments,
  teamsWithoutDepartment,
  teamsByDepartment,
  peopleByDepartment,
  peopleByTeam,
  peopleCount,
  unplacedCount,
  mayDepartments,
  mayTeams,
  onSelect,
}: {
  departments: EpmDepartment[];
  teamsWithoutDepartment: EpmTeam[];
  teamsByDepartment: Map<string, EpmTeam[]>;
  peopleByDepartment: Map<string, EpmEmployee[]>;
  peopleByTeam: Map<string, EpmEmployee[]>;
  peopleCount: number;
  unplacedCount: number;
  mayDepartments: boolean;
  mayTeams: boolean;
  onSelect: (selection: Selection) => void;
}) {
  const [creatingDepartment, setCreatingDepartment] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const placed = peopleCount - unplacedCount;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          actions={
            <AddMenu
              items={[
                mayDepartments ? { label: t('Add department'), onSelect: () => setCreatingDepartment(true) } : null,
                mayTeams ? { label: t('Add team'), onSelect: () => setCreatingTeam(true) } : null,
              ]}
            />
          }
        >
          <CardTitle>{t('Organization')}</CardTitle>
          <CardDescription>
            {t('{departments, plural, one {# department} other {# departments}}, {teams, plural, one {# team} other {# teams}}, and {placed, number} of {total, number} people placed in them.', {
              departments: departments.length,
              teams: departments.reduce((sum, item) => sum + (teamsByDepartment.get(item.id)?.length ?? 0), 0) + teamsWithoutDepartment.length,
              placed,
              total: peopleCount,
            })}
          </CardDescription>
        </CardHeader>
      </Card>

      <UnitTable
        title={t('Departments')}
        empty={t('No departments yet. Add one to start the structure.')}
        units={departments.map((item) => ({
          id: item.id,
          name: item.name,
          code: item.code,
          head: item.manager?.name,
          active: item.active,
          teams: teamsByDepartment.get(item.id)?.length ?? 0,
          people: peopleByDepartment.get(item.id)?.length ?? 0,
          department: item,
        }))}
        headLabel={t('Manager')}
        showTeams
        mayEdit={mayDepartments}
        onOpen={(id) => onSelect({ kind: 'department', id })}
      />

      {teamsWithoutDepartment.length > 0 ? (
        <UnitTable
          title={t('Teams without a department')}
          empty=""
          units={teamsWithoutDepartment.map((item) => ({
            id: item.id,
            name: item.name,
            code: item.code,
            head: item.lead?.name,
            active: item.active,
            teams: 0,
            people: peopleByTeam.get(item.id)?.length ?? 0,
            team: item,
          }))}
          headLabel={t('Lead')}
          mayEdit={mayTeams}
          departments={departments}
          onOpen={(id) => onSelect({ kind: 'team', id })}
        />
      ) : null}

      <DepartmentDialog open={creatingDepartment} onOpenChange={setCreatingDepartment} />
      <TeamDialog open={creatingTeam} onOpenChange={setCreatingTeam} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* One department                                                            */
/* ------------------------------------------------------------------------ */

function DepartmentDetail({
  department,
  teams,
  people,
  allPeople,
  peopleByTeam,
  mayDepartments,
  mayTeams,
  mayPeople,
  departments,
  onSelect,
}: {
  department: EpmDepartment;
  teams: EpmTeam[];
  people: EpmEmployee[];
  allPeople: EpmEmployee[];
  peopleByTeam: Map<string, EpmEmployee[]>;
  mayDepartments: boolean;
  mayTeams: boolean;
  mayPeople: boolean;
  departments: EpmDepartment[];
  onSelect: (selection: Selection) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useDeleteDepartment();

  const confirmDelete = () =>
    remove.mutate(department.id, {
      onSuccess: () => {
        toast.success(t('{name} was deleted', { name: department.name }));
        setDeleting(false);
        onSelect({ kind: 'organization' });
      },
      // The backend names what is still in the department.
      onError: (error) => toast.error(t('That could not be deleted'), { description: describeError(error) }),
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          actions={
            <div className="flex items-center gap-2">
              {mayDepartments ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('Edit')}
                </Button>
              ) : null}
              <AddMenu
                items={[
                  mayTeams ? { label: t('Add team'), onSelect: () => setCreatingTeam(true) } : null,
                  mayPeople ? { label: t('Add person'), onSelect: () => setAdding(true) } : null,
                ]}
              />
              {mayDepartments ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('Delete {name}', { name: department.name })}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          }
        >
          <Breadcrumb trail={[{ label: t('Organization'), onClick: () => onSelect({ kind: 'organization' }) }]} />
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span dir="auto">{department.name}</span>
            <Badge tone="neutral" size="sm" className="font-mono">{department.code}</Badge>
            {!department.active ? <Badge tone="warning" size="sm">{t('Archived')}</Badge> : null}
          </CardTitle>
          <CardDescription>
            {department.manager
              ? t('Managed by {name}.', { name: department.manager.name })
              : t('No manager set.')}{' '}
            {department.description ? <span dir="auto">{department.description}</span> : null}
          </CardDescription>
        </CardHeader>
      </Card>

      <UnitTable
        title={t('Teams')}
        empty={t('No teams in this department.')}
        units={teams.map((item) => ({
          id: item.id,
          name: item.name,
          code: item.code,
          head: item.lead?.name,
          active: item.active,
          teams: 0,
          people: peopleByTeam.get(item.id)?.length ?? 0,
          team: item,
        }))}
        headLabel={t('Lead')}
        mayEdit={mayTeams}
        departments={departments}
        onOpen={(id) => onSelect({ kind: 'team', id })}
      />

      <PeopleTable
        title={t('People')}
        people={people}
        showTeam
        mayPeople={mayPeople}
        removeLabel={t('Remove from department')}
        removeTitle={(person) => t('Remove {name} from the department?', { name: person.name })}
        // Leaving the department leaves its teams too: a team belongs to it.
        removeInput={() => ({})}
        empty={t('Nobody is in this department yet.')}
      />

      <DepartmentDialog open={editing} onOpenChange={setEditing} department={department} />
      <TeamDialog open={creatingTeam} onOpenChange={setCreatingTeam} defaultDepartmentId={department.id} />
      <AddPersonDialog
        open={adding}
        onOpenChange={setAdding}
        unitName={department.name}
        people={allPeople}
        isMember={(person) => person.department?.id === department.id && !person.team}
        input={() => ({ departmentId: department.id })}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('Delete {name}?', { name: department.name })}
        description={t('A department can be deleted once no team and nobody is in it. This cannot be undone; archiving it instead keeps its history.')}
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* One team                                                                  */
/* ------------------------------------------------------------------------ */

function TeamDetail({
  team,
  people,
  allPeople,
  mayTeams,
  mayPeople,
  departments,
  onSelect,
}: {
  team: EpmTeam;
  people: EpmEmployee[];
  allPeople: EpmEmployee[];
  mayTeams: boolean;
  mayPeople: boolean;
  departments: EpmDepartment[];
  onSelect: (selection: Selection) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useDeleteTeam();

  const parent = team.department;

  const confirmDelete = () =>
    remove.mutate(team.id, {
      onSuccess: () => {
        toast.success(t('{name} was deleted', { name: team.name }));
        setDeleting(false);
        onSelect(parent ? { kind: 'department', id: parent.id } : { kind: 'organization' });
      },
      onError: (error) => toast.error(t('That could not be deleted'), { description: describeError(error) }),
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          actions={
            <div className="flex items-center gap-2">
              {mayTeams ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('Edit')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setMoving(true)}>
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    {t('Change department')}
                  </Button>
                </>
              ) : null}
              {mayPeople ? (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('Add person')}
                </Button>
              ) : null}
              {mayTeams ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('Delete {name}', { name: team.name })}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          }
        >
          <Breadcrumb
            trail={[
              { label: t('Organization'), onClick: () => onSelect({ kind: 'organization' }) },
              ...(parent ? [{ label: parent.name, onClick: () => onSelect({ kind: 'department', id: parent.id }) }] : []),
            ]}
          />
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span dir="auto">{team.name}</span>
            <Badge tone="neutral" size="sm" className="font-mono">{team.code}</Badge>
            {!team.active ? <Badge tone="warning" size="sm">{t('Archived')}</Badge> : null}
          </CardTitle>
          <CardDescription>
            {team.lead ? t('Led by {name}.', { name: team.lead.name }) : t('No lead set.')}{' '}
            {parent ? null : t('Not in a department.')}{' '}
            {team.description ? <span dir="auto">{team.description}</span> : null}
          </CardDescription>
        </CardHeader>
      </Card>

      <PeopleTable
        title={t('People')}
        people={people}
        mayPeople={mayPeople}
        removeLabel={t('Remove from team')}
        removeTitle={(person) => t('Remove {name} from the team?', { name: person.name })}
        // They stay in the department; only the team is left.
        removeInput={(person) => ({ departmentId: parent?.id ?? person.department?.id })}
        empty={t('Nobody is in this team yet.')}
      />

      <TeamDialog open={editing} onOpenChange={setEditing} team={team} />
      <MoveTeamDialog open={moving} onOpenChange={setMoving} team={team} departments={departments} />
      <AddPersonDialog
        open={adding}
        onOpenChange={setAdding}
        unitName={team.name}
        people={allPeople}
        isMember={(person) => person.team?.id === team.id}
        input={() => ({ departmentId: parent?.id, teamId: team.id })}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('Delete {name}?', { name: team.name })}
        description={t('A team can be deleted once nobody is in it. This cannot be undone; archiving it instead keeps its history.')}
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* People in no unit                                                         */
/* ------------------------------------------------------------------------ */

function UnplacedDetail({ people, mayPeople }: { people: EpmEmployee[]; mayPeople: boolean }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('Not placed')}</CardTitle>
          <CardDescription>
            {t('People in no department and no team. Use Move to place someone.')}
          </CardDescription>
        </CardHeader>
      </Card>
      <PeopleTable
        title={t('People')}
        people={people}
        mayPeople={mayPeople}
        empty={t('Everyone is placed in a department or a team.')}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Shared pieces                                                             */
/* ------------------------------------------------------------------------ */

function Breadcrumb({ trail }: { trail: { label: string; onClick: () => void }[] }) {
  return (
    <nav aria-label={t('Where this sits')} className="mb-1 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
      {trail.map((step, index) => (
        <span key={`${step.label}-${index}`} className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={step.onClick}
            className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            dir="auto"
          >
            {step.label}
          </button>
          <ChevronRight className="h-3 w-3 rtl:rotate-180" aria-hidden />
        </span>
      ))}
    </nav>
  );
}

function AddMenu({ items }: { items: ({ label: string; onSelect: () => void } | null)[] }) {
  const offered = items.filter((item): item is { label: string; onSelect: () => void } => Boolean(item));
  if (offered.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          {t('Add')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {offered.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface UnitRow {
  id: string;
  name: string;
  code: string;
  head?: string;
  active: boolean;
  teams: number;
  people: number;
  department?: EpmDepartment;
  team?: EpmTeam;
}

/** Departments or teams, one row each, with what can be done to each. */
function UnitTable({
  title,
  empty,
  units,
  headLabel,
  showTeams,
  mayEdit,
  departments,
  onOpen,
}: {
  title: string;
  empty: string;
  units: UnitRow[];
  headLabel: string;
  showTeams?: boolean;
  mayEdit: boolean;
  departments?: EpmDepartment[];
  onOpen: (id: string) => void;
}) {
  const [editingDepartment, setEditingDepartment] = useState<EpmDepartment>();
  const [editingTeam, setEditingTeam] = useState<EpmTeam>();
  const [movingTeam, setMovingTeam] = useState<EpmTeam>();

  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-xs font-semibold tracking-tight">{title}</h3>
      {units.length === 0 ? (
        <EmptyState size="inline" icon={UsersRound} title={empty} />
      ) : (
        <AdminTable>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Code')}</TableHead>
              <TableHead>{headLabel}</TableHead>
              {showTeams ? <TableHead numeric>{t('Teams')}</TableHead> : null}
              <TableHead numeric>{t('People')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((unit) => (
              <TableRow key={unit.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => onOpen(unit.id)}
                    className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    dir="auto"
                  >
                    {unit.name}
                  </button>
                  {!unit.active ? (
                    <Badge tone="warning" size="sm" className="ms-2">{t('Archived')}</Badge>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-2xs">{unit.code}</TableCell>
                <TableCell className="text-xs" dir="auto">
                  {unit.head ?? <span className="text-muted-foreground">{'—'}</span>}
                </TableCell>
                {showTeams ? <TableCell numeric>{unit.teams}</TableCell> : null}
                <TableCell numeric>{unit.people}</TableCell>
                <TableCell className="text-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {name}', { name: unit.name })}>
                        <Ellipsis className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onOpen(unit.id)}>
                        <ChevronRight className="rtl:rotate-180" />
                        {t('Open')}
                      </DropdownMenuItem>
                      {mayEdit && unit.department ? (
                        <DropdownMenuItem onSelect={() => setEditingDepartment(unit.department)}>
                          <Pencil />
                          {t('Edit')}
                        </DropdownMenuItem>
                      ) : null}
                      {mayEdit && unit.team ? (
                        <>
                          <DropdownMenuItem onSelect={() => setEditingTeam(unit.team)}>
                            <Pencil />
                            {t('Edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setMovingTeam(unit.team)}>
                            <ArrowRightLeft />
                            {t('Change department')}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      )}

      <DepartmentDialog
        open={Boolean(editingDepartment)}
        onOpenChange={(open) => !open && setEditingDepartment(undefined)}
        department={editingDepartment}
      />
      <TeamDialog
        open={Boolean(editingTeam)}
        onOpenChange={(open) => !open && setEditingTeam(undefined)}
        team={editingTeam}
      />
      {movingTeam ? (
        <MoveTeamDialog
          open
          onOpenChange={(open) => !open && setMovingTeam(undefined)}
          team={movingTeam}
          departments={departments ?? []}
        />
      ) : null}
    </section>
  );
}

/** The people of one unit, with moving them and taking them out of it. */
function PeopleTable({
  title,
  people,
  showTeam,
  mayPeople,
  removeLabel,
  removeTitle,
  removeInput,
  empty,
}: {
  title: string;
  people: EpmEmployee[];
  showTeam?: boolean;
  mayPeople: boolean;
  /** Absent where there is nothing to be removed from. */
  removeLabel?: string;
  /** The question asked before removing someone. */
  removeTitle?: (person: EpmEmployee) => string;
  removeInput?: (person: EpmEmployee) => { departmentId?: string; teamId?: string };
  empty: string;
}) {
  const setMapping = useSetMapping();
  const [search, setSearch] = useState('');
  const [moving, setMoving] = useState<EpmEmployee>();
  const [removing, setRemoving] = useState<EpmEmployee>();

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) =>
      [person.name, person.email, person.team?.name].some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [people, search]);
  const paging = usePagination(matches, { pageSize: PEOPLE_PAGE_SIZE, resetKey: search });

  const confirmRemove = () => {
    if (!removing || !removeInput) return;
    const person = removing;
    setMapping.mutate(
      { id: person.id, input: removeInput(person) },
      {
        onSuccess: () => {
          toast.success(t('{name} was removed', { name: person.name }));
          setRemoving(undefined);
        },
        onError: (error) => toast.error(t('That could not be changed'), { description: describeError(error) }),
      },
    );
  };

  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-tight">
          {title} <span className="font-normal text-muted-foreground">({people.length})</span>
        </h3>
        {people.length > 8 ? (
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('Filter by name')}
            aria-label={t('Filter people by name')}
            className="w-56"
          />
        ) : null}
      </div>

      {people.length === 0 ? (
        <EmptyState size="inline" icon={Users} title={empty} />
      ) : (
        <AdminTable
          footer={
            matches.length > PEOPLE_PAGE_SIZE ? (
              <AdminPagination paging={paging} itemLabel={t('person')} itemLabelPlural={t('people')} />
            ) : undefined
          }
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Email')}</TableHead>
              {showTeam ? <TableHead>{t('Team')}</TableHead> : null}
              <TableHead className="w-12">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((person) => (
              <TableRow key={person.id}>
                <TableCell className="font-medium" dir="auto">{person.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{person.email ?? '—'}</TableCell>
                {showTeam ? (
                  <TableCell className="text-xs" dir="auto">
                    {person.team?.name ?? <span className="text-muted-foreground">{'—'}</span>}
                  </TableCell>
                ) : null}
                <TableCell className="text-end">
                  {mayPeople ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {name}', { name: person.name })}>
                          <Ellipsis className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setMoving(person)}>
                          <ArrowRightLeft />
                          {t('Move')}
                        </DropdownMenuItem>
                        {removeLabel && removeInput ? (
                          <DropdownMenuItem destructive onSelect={() => setRemoving(person)}>
                            <UserMinus />
                            {removeLabel}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {matches.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={showTeam ? 4 : 3} className="text-center text-xs text-muted-foreground">
                  {t('Nobody matches “{search}”.', { search: search.trim() })}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </AdminTable>
      )}

      <MappingDialog
        open={Boolean(moving)}
        onOpenChange={(open) => !open && setMoving(undefined)}
        employee={moving}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={removing && removeTitle ? removeTitle(removing) : t('Remove')}
        description={t('They keep their account and their work; only where they sit changes.')}
        confirmLabel={t('Remove')}
        pending={setMapping.isPending}
        onConfirm={confirmRemove}
      />
    </section>
  );
}

/**
 * Puts someone into a department or a team. Anyone already somewhere else is
 * moved, and the dialog says so before it happens, because a person belongs
 * to one place at a time.
 */
function AddPersonDialog({
  open,
  onOpenChange,
  unitName,
  people,
  isMember,
  input,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitName: string;
  people: EpmEmployee[];
  isMember: (person: EpmEmployee) => boolean;
  input: () => { departmentId?: string; teamId?: string };
}) {
  const setMapping = useSetMapping();
  const [personId, setPersonId] = useState<string>();

  const candidates = useMemo(() => people.filter((person) => !isMember(person)), [people, isMember]);
  const options = useMemo(
    () =>
      candidates.map((person) => ({
        id: person.id,
        name: person.name,
        hint: placeOf(person) ?? person.email,
      })),
    [candidates],
  );
  const chosen = candidates.find((person) => person.id === personId);
  const from = chosen ? placeOf(chosen) : undefined;

  const close = (next: boolean) => {
    if (!next) setPersonId(undefined);
    onOpenChange(next);
  };

  const submit = () => {
    if (!chosen) return;
    setMapping.mutate(
      { id: chosen.id, input: input() },
      {
        onSuccess: () => {
          toast.success(t('{name} added to {unit}', { name: chosen.name, unit: unitName }));
          close(false);
        },
        onError: (error) => toast.error(t('That could not be changed'), { description: describeError(error) }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Add a person to {unit}', { unit: unitName })}</DialogTitle>
          <DialogDescription>{t('A person belongs to one department and at most one team.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="organization-person">{t('Person')}</Label>
            <ComboSelect
              id="organization-person"
              label={t('Person')}
              options={options}
              value={personId}
              onChange={setPersonId}
              placeholder={t('Choose a person')}
              emptyLabel={t('Nobody else to add')}
            />
          </div>
          {chosen && from ? (
            <Alert tone="warning">
              {t('{name} is in {place} now. Adding them here moves them.', { name: chosen.name, place: from })}
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={setMapping.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} loading={setMapping.isPending} disabled={!chosen}>
            {from ? t('Move here') : t('Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where someone sits now, in words, or nothing when they are not placed. */
function placeOf(person: EpmEmployee): string | undefined {
  if (person.team && person.department) return `${person.department.name} · ${person.team.name}`;
  return person.team?.name ?? person.department?.name;
}

/** Moves a team under another department, or out of any department. */
function MoveTeamDialog({
  open,
  onOpenChange,
  team,
  departments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: EpmTeam;
  departments: EpmDepartment[];
}) {
  const update = useUpdateTeam();
  const [target, setTarget] = useState(team.department?.id ?? NO_DEPARTMENT);

  const options = departments.filter((item) => item.active || item.id === team.department?.id);
  const unchanged = target === (team.department?.id ?? NO_DEPARTMENT);

  const submit = () =>
    update.mutate(
      { id: team.id, input: { departmentId: target === NO_DEPARTMENT ? '' : target } },
      {
        onSuccess: () => {
          toast.success(t('{name} moved', { name: team.name }));
          onOpenChange(false);
        },
        onError: (error) => toast.error(t('That could not be changed'), { description: describeError(error) }),
      },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Change the department of {name}', { name: team.name })}</DialogTitle>
          <DialogDescription>{t('The team and its people move together.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-1">
          <Label htmlFor="organization-team-department">{t('Department')}</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="organization-team-department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEPARTMENT}>{t('No department')}</SelectItem>
              {options.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} loading={update.isPending} disabled={unchanged}>
            {t('Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
