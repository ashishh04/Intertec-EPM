import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ellipsis, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton, TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useAdminPermissions,
  useAdminRoles,
  useCreateRole,
  useDeleteRole,
  useUpdateRole,
} from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { formatNumber } from '@/lib/utils';
import type { AdminPermissionModule, AdminRole, AdminRoleKind } from '@/services/api/admin';
import { describeError } from './shared-format';
import {
  CheckAllLinks,
  PermissionSectionHeader,
  ROLES_PATH,
  ROLE_KIND_LABEL,
  isEditableRole,
  permissionAppliesTo,
  sameStringSet,
  sortRoles,
} from './shared-roles';
import { AdminPagination, AdminTable, CheckCell } from './shared-tables';

/**
 * Roles and permissions, shaped like OpenProject's page of the same name.
 *
 * Without an item in the address this is the list of roles; with `new` or a
 * role id it is the editor: the name, whether the role is global, and every
 * permission the role may hold grouped by module.
 */
export default function RolesPage() {
  const { itemId } = useParams<{ itemId?: string }>();

  if (!itemId) return <RolesList />;
  return <RoleEditor roleId={itemId === 'new' ? undefined : itemId} />;
}

/* ------------------------------------------------------------------------ */
/* The list                                                                  */
/* ------------------------------------------------------------------------ */

function RolesList() {
  const navigate = useNavigate();
  const query = useAdminRoles();
  const remove = useDeleteRole();
  const [removing, setRemoving] = useState<AdminRole>();

  const items = useMemo(() => sortRoles(query.data ?? []), [query.data]);
  const paging = usePagination(items, { pageSize: 25 });

  const confirmRemove = () => {
    if (!removing) return;
    const label = removing.name;
    remove.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${label} was deleted`);
        setRemoving(undefined);
      },
      onError: (error) =>
        toast.error('That role could not be deleted', {
          description: describeError(error),
        }),
    });
  };

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <Button size="sm" asChild>
            <Link to={`${ROLES_PATH}/new`}>
              <Plus className="h-3.5 w-3.5" />
              New role
            </Link>
          </Button>
        }
      >
        <ResultCount count={items.length} label="role" />
      </ListToolbar>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        errorTitle="Unable to load roles"
        skeleton={<TableSkeleton columns={5} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="No roles"
            description="Roles appear here once the delivery system reports them."
            action={{
              label: 'New role',
              onClick: () => navigate(`${ROLES_PATH}/new`),
            }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="role" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Built-in</TableHead>
              <TableHead numeric>Permissions</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((role) => {
              const editable = isEditableRole(role);
              return (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">
                    {editable ? (
                      <Link
                        to={`${ROLES_PATH}/${role.id}`}
                        className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {role.name}
                      </Link>
                    ) : (
                      role.name
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone="neutral" size="sm">
                      {ROLE_KIND_LABEL[role.kind] ?? role.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <CheckCell value={role.builtin} label="Built-in" />
                  </TableCell>
                  <TableCell numeric>{formatNumber(role.permissions.length)}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Actions for ${role.name}`}
                        >
                          <Ellipsis className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {editable ? (
                          <DropdownMenuItem onSelect={() => navigate(`${ROLES_PATH}/${role.id}`)}>
                            <Pencil />
                            Edit
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          destructive
                          disabled={role.builtin}
                          onSelect={() => setRemoving(role)}
                        >
                          <Trash2 />
                          Delete
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

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              The role is removed from the delivery system. A role that is still assigned to a
              member cannot be deleted until those memberships change.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={remove.isPending}
            >
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
/* The editor                                                                */
/* ------------------------------------------------------------------------ */

function RoleEditor({ roleId }: { roleId?: string }) {
  const roles = useAdminRoles();
  const permissions = useAdminPermissions();

  const role = roleId ? roles.data?.find((item) => item.id === roleId) : undefined;
  const loaded = !roles.isLoading && !permissions.isLoading;

  return (
    <QueryBoundary
      isLoading={!loaded}
      isError={roles.isError || permissions.isError}
      error={roles.error ?? permissions.error}
      onRetry={() => {
        void roles.refetch();
        void permissions.refetch();
      }}
      errorTitle="Unable to load the role"
      skeleton={<ListSkeleton rows={2} height="h-48" />}
    >
      {roleId && !role ? (
        <RoleNotFound />
      ) : role && !isEditableRole(role) ? (
        <RoleNotEditable role={role} />
      ) : (
        <RoleForm
          key={role?.id ?? 'new'}
          role={role}
          roles={roles.data ?? []}
          modules={permissions.data ?? []}
        />
      )}
    </QueryBoundary>
  );
}

function RoleNotFound() {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={ShieldCheck}
      title="Role not found"
      description="No role has this address. It may have been deleted."
      action={{ label: 'Back to roles', onClick: () => navigate(ROLES_PATH) }}
    />
  );
}

function RoleNotEditable({ role }: { role: AdminRole }) {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={ShieldCheck}
      title={`${role.name} cannot be edited`}
      description={`${ROLE_KIND_LABEL[role.kind] ?? 'This kind of role'} is fixed by the delivery system.`}
      action={{ label: 'Back to roles', onClick: () => navigate(ROLES_PATH) }}
    />
  );
}

const NO_WORKFLOW = '__none__';

function RoleForm({
  role,
  roles,
  modules,
}: {
  /** Absent when creating. */
  role?: AdminRole;
  roles: AdminRole[];
  modules: AdminPermissionModule[];
}) {
  const navigate = useNavigate();
  const create = useCreateRole();
  const update = useUpdateRole();

  const creating = !role;
  const [name, setName] = useState(role?.name ?? '');
  const [global, setGlobal] = useState(role?.kind === 'global');
  const [copyFrom, setCopyFrom] = useState(NO_WORKFLOW);
  const [granted, setGranted] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const kind: AdminRoleKind = global ? 'global' : 'project';

  // Each module with only the permissions this kind of role may hold, dropping
  // modules that would be empty (every permission in them is of the other kind).
  const sections = useMemo(
    () =>
      modules
        .map((module) => ({
          ...module,
          permissions: module.permissions.filter((permission) =>
            permissionAppliesTo(permission, kind),
          ),
        }))
        .filter((module) => module.permissions.length > 0),
    [modules, kind],
  );

  const applicable = useMemo(
    () => new Set(sections.flatMap((module) => module.permissions.map((item) => item.name))),
    [sections],
  );
  const selected = useMemo(
    () => [...granted].filter((permission) => applicable.has(permission)),
    [granted, applicable],
  );

  const projectRoles = useMemo(
    () => sortRoles(roles.filter((item) => item.kind === 'project')),
    [roles],
  );

  const nameError = submitted && name.trim() === '' ? 'Enter a name for the role.' : undefined;
  const dirty = creating
    ? true
    : name.trim() !== role.name || !sameStringSet(selected, role.permissions);
  const pending = create.isPending || update.isPending;

  const setMany = (names: string[], value: boolean) =>
    setGranted((current) => {
      const next = new Set(current);
      for (const item of names) {
        if (value) next.add(item);
        else next.delete(item);
      }
      return next;
    });

  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const trimmed = name.trim();
    if (trimmed === '') return;

    const onError = (error: unknown) =>
      toast.error(creating ? 'The role was not created' : 'The role was not saved', {
        description: describeError(error),
      });

    if (creating) {
      create.mutate(
        {
          name: trimmed,
          global,
          copyWorkflowFromRoleId: !global && copyFrom !== NO_WORKFLOW ? copyFrom : undefined,
          permissions: selected,
        },
        {
          onSuccess: (created) => {
            toast.success(`${created.name} was created`);
            navigate(ROLES_PATH);
          },
          onError,
        },
      );
      return;
    }

    update.mutate(
      {
        id: role.id,
        input: role.builtin ? { permissions: selected } : { name: trimmed, permissions: selected },
      },
      {
        onSuccess: (saved) => {
          toast.success(`${saved.name} was saved`);
          navigate(ROLES_PATH);
        },
        onError,
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{creating ? 'New role' : role.name}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-name" required={!role?.builtin}>
              Name
            </Label>
            <Input
              id="role-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              readOnly={role?.builtin}
              disabled={pending}
              invalid={Boolean(nameError)}
              aria-describedby={
                nameError ? 'role-name-error' : role?.builtin ? 'role-name-hint' : undefined
              }
              maxLength={256}
              autoComplete="off"
            />
            {nameError ? (
              <FieldError id="role-name-error">{nameError}</FieldError>
            ) : role?.builtin ? (
              <FieldHint id="role-name-hint">
                Built-in roles keep their name. Their permissions can still be changed.
              </FieldHint>
            ) : null}
          </div>

          {creating ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 pt-0.5 sm:pt-6">
                <Checkbox
                  id="role-global"
                  checked={global}
                  disabled={pending}
                  onCheckedChange={(checked) => setGlobal(checked === true)}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="role-global" className="leading-4">
                    Global role
                  </Label>
                  <FieldHint>
                    Held by a person across the whole instance rather than inside a project.
                  </FieldHint>
                </div>
              </div>

              {!global ? (
                <div className="space-y-1.5">
                  <Label htmlFor="role-copy-workflow">Copy workflow from</Label>
                  <Select value={copyFrom} onValueChange={setCopyFrom} disabled={pending}>
                    <SelectTrigger id="role-copy-workflow">
                      <SelectValue placeholder="Do not copy" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_WORKFLOW}>Do not copy</SelectItem>
                      {projectRoles.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldHint>
                    The status transitions the chosen role may make are copied to the new one.
                  </FieldHint>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label id="role-kind-label">Type</Label>
              <p className="pt-1" aria-labelledby="role-kind-label">
                <Badge tone="neutral" size="sm">
                  {ROLE_KIND_LABEL[role.kind]}
                </Badge>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Permissions</CardTitle>
          <CardDescription aria-live="polite">
            {formatNumber(selected.length)} of {formatNumber(applicable.size)} granted
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {sections.length === 0 ? (
            <EmptyState
              size="inline"
              title="No permissions to set"
              description="The delivery system reported no permissions for this kind of role."
            />
          ) : (
            <div className="space-y-6">
              {sections.map((module) => {
                const names = module.permissions.map((item) => item.name);
                const checkedCount = names.filter((item) => granted.has(item)).length;
                const isCollapsed = Boolean(collapsed[module.id]);
                const bodyId = `permissions-${module.id}`;
                return (
                  <section key={module.id} aria-labelledby={`${bodyId}-heading`}>
                    <div id={`${bodyId}-heading`} className="border-b border-border pb-2">
                      <PermissionSectionHeader
                        id={bodyId}
                        label={module.label}
                        checked={checkedCount}
                        total={names.length}
                        collapsed={isCollapsed}
                        onToggle={() => toggleCollapsed(module.id)}
                        onCheckAll={() => setMany(names, true)}
                        onUncheckAll={() => setMany(names, false)}
                        disabled={pending}
                      />
                    </div>
                    {isCollapsed ? null : (
                      <div id={bodyId} className="grid gap-x-6 gap-y-3 pt-3 sm:grid-cols-2">
                        {module.permissions.map((permission) => {
                          const id = `permission-${permission.name}`;
                          return (
                            <div key={permission.name} className="flex items-start gap-2.5">
                              <Checkbox
                                id={id}
                                checked={granted.has(permission.name)}
                                disabled={pending}
                                onCheckedChange={(checked) =>
                                  setMany([permission.name], checked === true)
                                }
                                className="mt-0.5"
                              />
                              <div className="min-w-0 space-y-0.5">
                                <Label htmlFor={id} className="font-normal leading-4">
                                  {permission.label}
                                </Label>
                                {permission.explanation ? (
                                  <p className="text-2xs italic text-muted-foreground">
                                    {permission.explanation}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending} disabled={!dirty}>
          {creating ? 'Create' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" asChild>
          <Link to={ROLES_PATH}>Cancel</Link>
        </Button>
        {sections.length > 0 ? (
          <span className="ml-auto">
            <CheckAllLinks
              scope="permissions"
              onCheckAll={() => setMany([...applicable], true)}
              onUncheckAll={() => setMany([...applicable], false)}
              disabled={pending}
            />
          </span>
        ) : null}
      </div>
    </form>
  );
}
