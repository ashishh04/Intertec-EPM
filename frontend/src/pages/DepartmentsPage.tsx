import { useState } from 'react';
import { toast } from 'sonner';
import { Archive, Building2, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';

import { DepartmentDialog } from '@/components/departments/DepartmentDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
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
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useDeleteDepartment, useDepartments, useSetDepartmentActive } from '@/hooks/useDepartments';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmDepartment } from '@/services/api/departments';

/**
 * The department directory.
 *
 * The first page backed entirely by EPM's own database rather than a view onto
 * OpenProject. Everyone signed in can read it — departments are reference data
 * other features will need — while creating and changing them needs
 * `departments:manage`, which the backend checks on every write regardless of
 * what is rendered here.
 *
 * Departments are archived, never deleted, because teams and employee mappings
 * will come to reference them.
 */
export default function DepartmentsPage() {
  const { can } = useAuth();
  const mayManage = can('departments:manage');

  const [showArchived, setShowArchived] = useState(false);
  const departments = useDepartments(showArchived);
  const setActive = useSetDepartmentActive();
  const users = useUserMap();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmDepartment>();

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (department: EpmDepartment) => {
    setEditing(department);
    setDialogOpen(true);
  };

  const [removing, setRemoving] = useState<EpmDepartment>();
  const deleteDepartment = useDeleteDepartment();

  const confirmRemove = () => {
    if (!removing) return;
    const name = removing.name;

    deleteDepartment.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${name} deleted`);
        setRemoving(undefined);
      },
      // The message names what is still in the department, so it is shown
      // rather than replaced with something generic.
      onError: (error) =>
        toast.error('That could not be deleted', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const toggleActive = (department: EpmDepartment) => {
    const active = !department.active;

    setActive.mutate(
      { id: department.id, active },
      {
        onSuccess: () => toast.success(active ? 'Department restored' : 'Department archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const items = departments.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Departments"
        description="Organisational units defined in EPM."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showArchived}
                onCheckedChange={setShowArchived}
                aria-label="Show archived departments"
              />
              Show archived
            </label>

            {mayManage ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New department
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryBoundary
        isLoading={departments.isLoading}
        isError={departments.isError}
        onRetry={() => departments.refetch()}
        errorTitle="Unable to load departments"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        }
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={Building2}
            title={showArchived ? 'No departments' : 'No active departments'}
            description={
              mayManage
                ? 'Create a department to describe how the organisation is structured.'
                : 'No departments have been set up yet.'
            }
          />
        }
      >
        <ul className="space-y-2">
          {items.map((department) => (
            <li key={department.id}>
              <Card className="flex items-center gap-4 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{department.name}</span>
                    <Badge className="font-mono text-2xs">
                      {department.code}
                    </Badge>
                    {!department.active ? (
                      <Badge tone="warning" className="text-2xs">
                        Archived
                      </Badge>
                    ) : null}
                  </div>
                  {department.description ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {department.description}
                    </p>
                  ) : null}
                </div>

                <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  <span>
                    {department.memberCount} · {department.capacityHours} h/wk
                  </span>
                </div>

                {department.manager ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {/* The name comes from the backend; the directory is only
                        consulted for the avatar. */}
                    <UserAvatarWithTooltip user={users.get(department.manager.id)} size="xs" />
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {department.manager.name}
                    </span>
                  </div>
                ) : (
                  <span className="hidden text-xs text-muted-foreground sm:inline">No manager</span>
                )}

                {mayManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${department.name}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openEdit(department)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>

                    <button
                      type="button"
                      aria-label={
                        department.active
                          ? `Archive ${department.name}`
                          : `Restore ${department.name}`
                      }
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => toggleActive(department)}
                    >
                      {department.active ? (
                        <Archive className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>

                    {/* Deleting is for a department created by mistake;
                        archiving is the ordinary lifecycle and keeps the
                        record. The backend refuses while anything still
                        references it, and says what. */}
                    <button
                      type="button"
                      aria-label={`Delete ${department.name}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setRemoving(department)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </QueryBoundary>

      <DepartmentDialog open={dialogOpen} onOpenChange={setDialogOpen} department={editing} />

      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              This removes the department from EPM permanently. Archiving keeps it and can be
              undone; deleting cannot. It is refused if any team or person is still in it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={deleteDepartment.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmRemove}
              disabled={deleteDepartment.isPending}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
