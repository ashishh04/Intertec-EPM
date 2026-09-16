import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, UserRoundX } from 'lucide-react';
import { toast } from 'sonner';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useAdminPlaceholderUsers,
  useCreatePlaceholderUser,
  useDeletePlaceholderUser,
} from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { formatLongDate } from '@/lib/utils';
import type { AdminPlaceholderUser } from '@/services/api/admin';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable, byName } from './shared-tables';

/**
 * Placeholder users: named stand-ins that can be assigned work before a real
 * person exists. Creating them is an Enterprise feature upstream, so the
 * instance may refuse; the refusal is shown in the dialog, word for word,
 * rather than guessed at beforehand.
 */
export default function PlaceholderUsersPage() {
  const placeholders = useAdminPlaceholderUsers();
  const remove = useDeletePlaceholderUser();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AdminPlaceholderUser>();

  const items = useMemo(() => [...(placeholders.data ?? [])].sort(byName), [placeholders.data]);
  const paging = usePagination(items, { pageSize: 25 });

  const confirmRemove = () => {
    if (!removing) return;
    const target = removing;

    remove.mutate(target.id, {
      onSuccess: () => {
        setRemoving(undefined);
        toast.success('Placeholder user deleted', { description: target.name });
      },
      onError: (error) =>
        toast.error('Placeholder user was not deleted', { description: describeError(error) }),
    });
  };

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            New placeholder user
          </Button>
        }
      >
        <ResultCount count={items.length} label="placeholder user" />
      </ListToolbar>

      <QueryBoundary
        isLoading={placeholders.isLoading}
        isError={placeholders.isError}
        error={placeholders.error}
        onRetry={() => void placeholders.refetch()}
        errorTitle="Unable to load placeholder users"
        skeleton={<TableSkeleton columns={3} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRoundX}
            title="No placeholder users yet"
            description="Placeholder users stand in for people who do not have an account yet, so work can be planned and assigned before they join."
            action={{ label: 'New placeholder user', onClick: () => setAdding(true) }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="placeholder user" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created on</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {formatLongDate(user.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${user.name}`}
                    className="text-muted-foreground hover:text-danger"
                    onClick={() => setRemoving(user)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <NewPlaceholderUserDialog open={adding} onOpenChange={setAdding} />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              Work assigned to this placeholder becomes unassigned, and it is removed from every
              project. This cannot be undone.
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
/* Create dialog                                                             */
/* ------------------------------------------------------------------------ */

interface NewPlaceholderUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function NewPlaceholderUserDialog({ open, onOpenChange }: NewPlaceholderUserDialogProps) {
  const create = useCreatePlaceholderUser();

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  // What the server said when it refused. Kept visible until the next attempt
  // so an Enterprise refusal can be read in full.
  const [refusal, setRefusal] = useState<string>();

  const reset = () => {
    setName('');
    setNameError(undefined);
    setRefusal(undefined);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRefusal(undefined);

    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Give the placeholder a name.');
      return;
    }
    setNameError(undefined);

    create.mutate(
      { name: trimmed },
      {
        onSuccess: (created) => {
          toast.success('Placeholder user created', { description: created.name });
          handleOpenChange(false);
        },
        onError: (error) => setRefusal(describeError(error, 'That could not be created.')),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New placeholder user</DialogTitle>
            <DialogDescription>
              A named stand-in that can be assigned work and added to projects before a real
              account exists.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="placeholder-user-name" required>
                Name
              </Label>
              <Input
                id="placeholder-user-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New developer"
                invalid={Boolean(nameError)}
                aria-describedby={nameError ? 'placeholder-user-name-error' : 'placeholder-user-name-hint'}
                autoFocus
                maxLength={255}
              />
              {nameError ? (
                <FieldError id="placeholder-user-name-error">{nameError}</FieldError>
              ) : (
                <FieldHint id="placeholder-user-name-hint">
                  Shown wherever a person would be, without a sign-in or an email address.
                </FieldHint>
              )}
            </div>

            {refusal ? (
              <Alert tone="danger" title="The delivery system did not create the placeholder">
                <span className="break-words">{refusal}</span>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
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
