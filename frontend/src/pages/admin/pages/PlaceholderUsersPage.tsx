import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, UserRoundCheck, UserRoundX } from 'lucide-react';
import { toast } from 'sonner';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminEnterprise, useAdminPlaceholderUsers } from '@/hooks/useAdmin';
import {
  useConvertPlaceholderPerson,
  useCreatePlaceholderPerson,
  useDeletePlaceholderPerson,
  usePlaceholderPeople,
} from '@/hooks/usePlaceholderPeople';
import { useTeams } from '@/hooks/useTeams';
import { useUsers } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { formatLongDate } from '@/lib/utils';
import type { EpmPlaceholderPerson } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable, byName } from './shared-tables';

const NONE = '__none__';

/**
 * Placeholder people: named stand-ins for roles that are planned but not filled.
 *
 * EPM's own records, and that is the whole reason this page works. OpenProject
 * has the same idea and gates creating one behind an Enterprise licence, so on
 * a Community instance the upstream feature does not exist — and a planner
 * still has to be able to say "a second backend engineer, starting in March"
 * before that person is hired.
 *
 * What a placeholder can do is bounded by what EPM owns, and the page says so
 * rather than letting someone discover it: it belongs to a team and carries
 * weekly capacity, so planned headcount counts toward team workload and
 * portfolio capacity. It cannot be a work package assignee, because only
 * OpenProject decides who is assignable. Converting is the way out — it hands
 * the team and capacity to the real account once it exists.
 *
 * Upstream placeholder users are still listed when an Enterprise instance has
 * any, so nothing already there disappears from view.
 */
export default function PlaceholderUsersPage() {
  const placeholders = usePlaceholderPeople();
  const enterprise = useAdminEnterprise();
  const upstream = useAdminPlaceholderUsers();
  const remove = useDeletePlaceholderPerson();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EpmPlaceholderPerson>();
  const [converting, setConverting] = useState<EpmPlaceholderPerson>();

  const items = useMemo(() => [...(placeholders.data ?? [])].sort(byName), [placeholders.data]);
  const paging = usePagination(items);

  const upstreamItems = upstream.data ?? [];

  const confirmRemove = () => {
    if (!removing) return;
    remove.mutate(removing.id, {
      onSuccess: () => {
        toast.success('Placeholder removed', { description: removing.name });
        setRemoving(undefined);
      },
      onError: (error) => toast.error('Could not remove it', { description: describeError(error) }),
    });
  };

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            New placeholder
          </Button>
        }
      >
        <ResultCount count={items.length} label="placeholder" />
      </ListToolbar>

      {/*
        * Said once, on the page, rather than discovered per action. A
        * placeholder is planning headcount; it is not an OpenProject principal
        * and cannot be assigned work, and someone should know that before they
        * build a plan on it.
        */}
      <Alert tone="neutral" title="Placeholders hold capacity, not assignments">
        A placeholder counts toward its team's workload and its portfolio's capacity, so planned
        headcount is visible before anyone is hired. Work packages can only be assigned to a real
        account — convert the placeholder when that person joins and their team and capacity carry
        across.
      </Alert>

      <QueryBoundary
        isLoading={placeholders.isLoading}
        isError={placeholders.isError}
        error={placeholders.error}
        onRetry={() => void placeholders.refetch()}
        skeleton={<TableSkeleton rows={4} columns={5} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRoundX}
            title="No placeholders yet"
            description="Add one for a role you are planning but have not filled, so its capacity shows in team and portfolio planning."
            action={{ label: 'New placeholder', onClick: () => setAdding(true) }}
          />
        }
        errorTitle="Placeholders could not be loaded"
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="placeholder" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Team</TableHead>
              <TableHead numeric>Weekly hours</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((person) => (
              <TableRow key={person.id}>
                <TableCell className="font-medium">
                  <span className="flex flex-col">
                    <span>{person.name}</span>
                    {person.note ? (
                      <span className="text-2xs text-muted-foreground">{person.note}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {person.team?.name ?? <span className="text-2xs">Unassigned</span>}
                </TableCell>
                <TableCell numeric className="font-mono text-2xs">
                  {person.hoursCapacity}
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {formatLongDate(person.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <span className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Convert ${person.name} to a real person`}
                      className="text-muted-foreground hover:text-primary"
                      onClick={() => setConverting(person)}
                    >
                      <UserRoundCheck className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${person.name}`}
                      className="text-muted-foreground hover:text-danger"
                      onClick={() => setRemoving(person)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      {/* Only where an Enterprise instance actually has some, so nothing that
          already exists upstream quietly disappears from this page. */}
      {upstreamItems.length > 0 ? (
        <section className="space-y-2">
          <h3 className="epm-eyebrow">
            OpenProject placeholder users
            <Badge size="sm" tone="neutral" className="ml-2">
              {upstreamItems.length}
            </Badge>
          </h3>
          <p className="text-2xs text-muted-foreground">
            Created in OpenProject under an Enterprise licence
            {enterprise.data?.allows.placeholderUsers === false
              ? ', which this instance no longer has. They are shown so they are not lost, and can still be assigned work upstream.'
              : '. These can be assigned work; the placeholders above cannot.'}
          </p>
          <AdminTable>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Created on</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upstreamItems.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(user.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminTable>
        </section>
      ) : null}

      <NewPlaceholderDialog open={adding} onOpenChange={setAdding} />
      <ConvertDialog person={converting} onClose={() => setConverting(undefined)} />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              Its capacity stops counting toward {removing?.team?.name ?? 'its team'} and its
              portfolio. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} loading={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Create                                                                    */
/* ------------------------------------------------------------------------ */

function NewPlaceholderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreatePlaceholderPerson();
  const teams = useTeams();

  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [teamId, setTeamId] = useState<string>(NONE);
  const [hours, setHours] = useState('40');
  const [error, setError] = useState<string>();

  const reset = () => {
    setName('');
    setNote('');
    setTeamId(NONE);
    setHours('40');
    setError(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the placeholder a name, e.g. "Backend engineer (Q2 start)".');
      return;
    }

    const capacity = Number(hours);
    if (!Number.isFinite(capacity) || capacity < 0 || capacity > 168) {
      setError('Weekly hours must be between 0 and 168.');
      return;
    }

    create.mutate(
      {
        name: trimmed,
        note: note.trim() || undefined,
        teamId: teamId === NONE ? null : teamId,
        hoursCapacity: capacity,
      },
      {
        onSuccess: (person) => {
          toast.success('Placeholder added', { description: person.name });
          reset();
          onOpenChange(false);
        },
        // The duplicate-name refusal is the one worth reading in full.
        onError: (failure) => setError(describeError(failure)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New placeholder</DialogTitle>
            <DialogDescription>
              A role you are planning but have not filled. Its capacity counts toward the team.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="placeholder-name" required>
                Name
              </Label>
              <Input
                id="placeholder-name"
                autoFocus
                placeholder="Backend engineer (Q2 start)"
                value={name}
                onChange={(event) => setName(event.target.value)}
                invalid={Boolean(error)}
              />
              <FieldHint>Shown wherever the role would be, without an account.</FieldHint>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="placeholder-team">Team</Label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger id="placeholder-team">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {(teams.data ?? []).map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldHint>The department follows the team.</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="placeholder-hours">Weekly hours</Label>
                <Input
                  id="placeholder-hours"
                  inputMode="decimal"
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                />
                <FieldHint>Planned capacity.</FieldHint>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="placeholder-note">Note</Label>
              <Textarea
                id="placeholder-note"
                rows={2}
                placeholder="What this role is for."
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            {error ? <FieldError>{error}</FieldError> : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------ */
/* Convert                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Hands a placeholder's plan to the person who filled the role.
 *
 * The account is created on the Users page, where account creation belongs.
 * This only says which existing person the placeholder became, and moves the
 * team and capacity onto them — so the headcount that was planned does not
 * disappear and reappear as a gap in the same week someone joined.
 */
function ConvertDialog({
  person,
  onClose,
}: {
  person?: EpmPlaceholderPerson;
  onClose: () => void;
}) {
  const convert = useConvertPlaceholderPerson();
  const { data: users } = useUsers();

  const [userId, setUserId] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = () => {
    if (!person) return;
    if (!userId) {
      setError('Choose the person who filled this role.');
      return;
    }

    convert.mutate(
      { id: person.id, userId },
      {
        onSuccess: () => {
          toast.success('Placeholder converted', {
            description: `${person.name} is now ${users?.find((u) => u.id === userId)?.name ?? 'a real person'}.`,
          });
          setUserId(undefined);
          setError(undefined);
          onClose();
        },
        onError: (failure) => setError(describeError(failure)),
      },
    );
  };

  return (
    <Dialog
      open={Boolean(person)}
      onOpenChange={(open) => {
        if (!open) {
          setUserId(undefined);
          setError(undefined);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convert {person?.name}</DialogTitle>
          <DialogDescription>
            Name the person who filled this role. Its team and {person?.hoursCapacity} weekly hours
            move onto them, and the placeholder stops counting separately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 py-2">
          <Label htmlFor="convert-user" required>
            Person
          </Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="convert-user">
              <SelectValue placeholder="Select a person" />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {(users ?? []).map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint>Create the account on the Users page first if they are not listed.</FieldHint>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={convert.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={convert.isPending}>
            Convert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
