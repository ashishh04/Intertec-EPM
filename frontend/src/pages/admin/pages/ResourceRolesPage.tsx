import { useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Tags } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableSkeleton } from '@/components/common/DataTable';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCreateRole, useResourceRoles, useUpdateRole } from '@/hooks/useResources';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { ResourceRole } from '@/types';
import { describeError } from './shared-format';
import { AdminTable } from './shared-tables';

/**
 * The kinds of work people do — "Backend developer", "Business analyst" — so
 * capacity, demand and utilisation can be read by role (BR-313 to BR-315).
 * EPM's own list: OpenProject's roles are project permissions, not jobs. Each
 * person and placeholder holds at most one, set where they are staffed.
 */
export default function ResourceRolesPage() {
  const { can } = useAuth();
  const manage = can('employees:manage');
  const [showArchived, setShowArchived] = useState(false);
  const roles = useResourceRoles(showArchived);
  const update = useUpdateRole();
  const [editing, setEditing] = useState<ResourceRole | 'new' | null>(null);

  return (
    <div className="space-y-4">
      {!manage ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Changing roles needs the staffing permission (employees:manage).')}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label={t('Show archived roles')} />
          {t('Show archived roles')}
        </label>
        {manage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" />
            {t('New role')}
          </Button>
        ) : null}
      </div>
      <QueryBoundary
        isLoading={roles.isLoading}
        isError={roles.isError}
        error={roles.error}
        onRetry={() => void roles.refetch()}
        skeleton={<TableSkeleton rows={4} />}
        isEmpty={roles.data?.length === 0}
        empty={<EmptyState icon={Tags} title={t('No roles yet')} description={t('Add the kinds of work people do, then give each person theirs on the Employees page.')} />}
      >
        <AdminTable>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Role')}</TableHead>
              <TableHead numeric>{t('People')}</TableHead>
              <TableHead numeric>{t('Placeholders')}</TableHead>
              {manage ? <TableHead className="w-24" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody data-testid="resource-roles">
            {(roles.data ?? []).map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <span className="font-medium text-foreground" dir="auto">
                    {role.name}
                  </span>
                  {role.archived ? (
                    <Badge tone="neutral" size="sm" className="ms-2">
                      {t('Archived')}
                    </Badge>
                  ) : null}
                  {role.description ? (
                    <span className="block text-2xs text-muted-foreground" dir="auto">
                      {role.description}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell numeric>{role.people}</TableCell>
                <TableCell numeric>{role.placeholders}</TableCell>
                {manage ? (
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon-sm" aria-label={t('Rename {name}', { name: role.name })} onClick={() => setEditing(role)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={role.archived ? t('Restore {name}', { name: role.name }) : t('Archive {name}', { name: role.name })}
                      onClick={() =>
                        update.mutate(
                          { id: role.id, archived: !role.archived },
                          { onError: (error) => toast.error(t('The role was not changed'), { description: describeError(error) }) },
                        )
                      }
                    >
                      {role.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>
      {editing ? <RoleDialog role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RoleDialog({ role, onClose }: { role: ResourceRole | null; onClose: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const create = useCreateRole();
  const update = useUpdateRole();
  const pending = create.isPending || update.isPending;
  const problem = name.trim() ? null : t('A role needs a name.');
  const submit = () => {
    if (problem) return;
    const done = {
      onSuccess: () => {
        toast.success(role ? t('Role saved') : t('Role added'));
        onClose();
      },
      onError: (error: unknown) => toast.error(t('The role was not saved'), { description: describeError(error) }),
    };
    if (role) update.mutate({ id: role.id, name: name.trim(), description: description.trim() || null }, done);
    else create.mutate({ name: name.trim(), description: description.trim() || null }, done);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{role ? t('Change role') : t('New role')}</DialogTitle>
          <DialogDescription>{t('A kind of work people do. Its name is unique, whatever the case.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">{t('Name')}</Label>
            <Input id="role-name" value={name} onChange={(event) => setName(event.target.value)} dir="auto" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-description">{t('Description')}</Label>
            <Textarea id="role-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} dir="auto" />
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={Boolean(problem)} loading={pending} onClick={submit}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
