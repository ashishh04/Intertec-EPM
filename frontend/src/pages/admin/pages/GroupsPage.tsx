import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Ellipsis, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { MultiSelect, type MultiSelectOption } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
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
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminGroups, useCreateGroup, useDeleteGroup, useUpdateGroup } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatLongDate, formatNumber } from '@/lib/utils';
import type { AdminGroup } from '@/services/api/admin';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable, byName } from './shared-tables';

/**
 * Groups, shaped like OpenProject's Groups administration page: one row per
 * group with how many people it holds, and a dialog to create or edit one
 * with its members chosen from the user directory.
 */
export default function GroupsPage() {
  const groups = useAdminGroups();
  const remove = useDeleteGroup();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminGroup>();
  const [removing, setRemoving] = useState<AdminGroup>();

  const items = useMemo(() => [...(groups.data ?? [])].sort(byName), [groups.data]);
  const paging = usePagination(items, { pageSize: 25 });

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (group: AdminGroup) => {
    setEditing(group);
    setDialogOpen(true);
  };

  const confirmRemove = () => {
    if (!removing) return;
    const target = removing;

    remove.mutate(target.id, {
      onSuccess: () => {
        setRemoving(undefined);
        toast.success(t('Group deleted'), { description: target.name });
      },
      onError: (error) =>
        toast.error(t('Group was not deleted'), { description: describeError(error) }),
    });
  };

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            {t('New group')}
          </Button>
        }
      >
        <ResultCount count={items.length} label={t('group')} plural={t('groups')} />
      </ListToolbar>

      <QueryBoundary
        isLoading={groups.isLoading}
        isError={groups.isError}
        error={groups.error}
        onRetry={() => void groups.refetch()}
        errorTitle={t('Unable to load groups')}
        skeleton={<TableSkeleton columns={5} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={Users}
            title={t('No groups')}
            description={t('Groups let several people be added to a project at once, with the same role.')}
            action={{ label: t('New group'), onClick: openCreate }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('group')} itemLabelPlural={t('groups')} />}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead numeric>{t('Members')}</TableHead>
              <TableHead>{t('Created')}</TableHead>
              <TableHead>{t('Updated')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((group) => {
              const members = [...(group.members ?? [])].sort(byName);
              const names = members.map((member) => member.name).join(', ');
              const count = group.memberCount ?? members.length;

              return (
                <TableRow key={group.id}>
                  <TableCell className="font-medium" dir="auto">{group.name}</TableCell>
                  <TableCell numeric>
                    <span
                      title={names || t('No members')}
                      aria-label={
                        names
                          ? t('{count, plural, one {# member} other {# members}}: {names}', { count, names })
                          : t('{count, plural, one {# member} other {# members}}', { count })
                      }
                    >
                      {formatNumber(count)}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(group.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(group.updatedAt)}
                  </TableCell>
                  <TableCell className="text-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {name}', { name: group.name })}>
                          <Ellipsis className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openEdit(group)}>
                          <Pencil />
                          {t('Edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onSelect={() => setRemoving(group)}>
                          <Trash2 />
                          {t('Delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <GroupDialog open={dialogOpen} onOpenChange={setDialogOpen} group={editing} />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Delete {name}?', { name: removing?.name })}</DialogTitle>
            <DialogDescription>
              {t('The group is removed from every project it is a member of, and its members lose the roles they held through it. Their own accounts are not touched. This cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={remove.isPending}>
              {t('Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove} loading={remove.isPending}>
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Create / edit dialog                                                      */
/* ------------------------------------------------------------------------ */

interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. Absent means create. */
  group?: AdminGroup;
}

function GroupDialog({ open, onOpenChange, group }: GroupDialogProps) {
  const isEdit = Boolean(group);
  const create = useCreateGroup();
  const update = useUpdateGroup();
  const users = useUsers();

  const [name, setName] = useState('');
  const [members, setMembers] = useState<MultiSelectOption[]>([]);
  const [problem, setProblem] = useState<string>();

  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it would reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setMembers([...(group?.members ?? [])].sort(byName));
    setProblem(undefined);
  }, [open, group?.id]);

  // The directory, plus any current member the directory does not list (a
  // locked or invited account, say), so editing never silently drops anyone.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: MultiSelectOption[] = [];
    for (const user of users.data ?? []) {
      seen.add(user.id);
      list.push({ id: user.id, name: user.name });
    }
    for (const member of group?.members ?? []) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      list.push(member);
    }
    return list.sort(byName);
  }, [users.data, group?.members]);

  const pending = create.isPending || update.isPending;

  const fail = (error: unknown) => setProblem(describeError(error, t('That could not be saved.')));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const trimmed = name.trim();
    if (!trimmed) {
      setProblem(t('Give the group a name.'));
      return;
    }

    const memberIds = members.map((member) => member.id);

    if (isEdit && group) {
      update.mutate(
        { id: group.id, input: { name: trimmed, memberIds } },
        {
          onSuccess: () => {
            toast.success(t('Group updated'), { description: trimmed });
            onOpenChange(false);
          },
          onError: fail,
        },
      );
      return;
    }

    create.mutate(
      { name: trimmed, memberIds },
      {
        onSuccess: (created) => {
          toast.success(t('Group created'), {
            description: t('{name}, {count, plural, one {# member} other {# members}}.', { name: created.name, count: memberIds.length }),
          });
          onOpenChange(false);
        },
        onError: fail,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isEdit ? t('Edit group') : t('New group')}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? t('Rename the group or change who is in it.')
                : t('A named set of people that can be added to projects together.')}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll space-y-4 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name" required>
                {t('Name')}
              </Label>
              <Input
                id="group-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('Platform team')}
                invalid={Boolean(problem) && !name.trim()}
                autoFocus
                maxLength={255}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="group-members">{t('Members')}</Label>
              <MultiSelect
                label={t('Members')}
                options={options}
                selected={members}
                onChange={setMembers}
                placeholder={users.isLoading ? t('Loading people') : t('Choose people')}
                disabled={pending}
                className="w-full"
                maxVisible={3}
              />
              <FieldHint id="group-members-hint">
                {members.length === 0
                  ? t('No members yet. A group can be created empty and filled later.')
                  : t('{count, plural, one {# member} other {# members}}.', { count: members.length })}
              </FieldHint>
            </div>

            {problem ? <FieldError>{problem}</FieldError> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {isEdit ? t('Save') : t('Create group')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
