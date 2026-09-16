import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminPermissions, useAdminRoles, useUpdateRole } from '@/hooks/useAdmin';
import type { AdminPermissionModule, AdminRole } from '@/services/api/admin';
import { cn, formatNumber, pluralize } from '@/lib/utils';
import { describeError } from './shared-format';
import {
  PermissionSectionHeader,
  ROLES_PATH,
  ROLE_KIND_LABEL,
  isEditableRole,
  permissionAppliesTo,
  sameStringSet,
  sortRoles,
} from './shared-roles';

/**
 * Permissions report, shaped like OpenProject's: every permission down the
 * side, every project and global role across the top, and a checkbox where
 * the permission can be granted to that kind of role. Edits are kept per
 * role and saved role by role, so a failure part-way leaves the roles that
 * did save in their new state and the rest still marked as unsaved.
 */
export default function PermissionsReportPage() {
  const roles = useAdminRoles();
  const permissions = useAdminPermissions();
  const loaded = !roles.isLoading && !permissions.isLoading;

  const columns = useMemo(() => sortRoles((roles.data ?? []).filter(isEditableRole)), [roles.data]);

  return (
    <QueryBoundary
      isLoading={!loaded}
      isError={roles.isError || permissions.isError}
      error={roles.error ?? permissions.error}
      onRetry={() => {
        void roles.refetch();
        void permissions.refetch();
      }}
      errorTitle="Unable to load the permissions report"
      skeleton={<TableSkeleton columns={5} rows={10} />}
      isEmpty={columns.length === 0 || (permissions.data ?? []).length === 0}
      empty={
        <EmptyState
          icon={ShieldCheck}
          title="Nothing to report"
          description="The report needs at least one project or global role and a permission catalogue."
        />
      }
    >
      <ReportMatrix roles={columns} modules={permissions.data ?? []} />
    </QueryBoundary>
  );
}

function ReportMatrix({
  roles,
  modules,
}: {
  roles: AdminRole[];
  modules: AdminPermissionModule[];
}) {
  const update = useUpdateRole();

  // Only the roles that have been touched, each as its full permission set.
  // Anything not here shows what the server said.
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const serverById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  const grantsFor = (role: AdminRole): Set<string> => edits[role.id] ?? new Set(role.permissions);

  const dirtyRoles = roles.filter((role) => {
    const edited = edits[role.id];
    return edited ? !sameStringSet([...edited], role.permissions) : false;
  });
  const dirty = dirtyRoles.length > 0;

  const apply = (changes: { roleId: string; names: string[]; value: boolean }[]) =>
    setEdits((current) => {
      const next = { ...current };
      for (const change of changes) {
        const role = serverById.get(change.roleId);
        if (!role) continue;
        const set = new Set(next[change.roleId] ?? role.permissions);
        for (const name of change.names) {
          if (change.value) set.add(name);
          else set.delete(name);
        }
        next[change.roleId] = set;
      }
      return next;
    });

  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));

  const reset = () => setEdits({});

  const save = async () => {
    setSaving(true);
    let saved = 0;
    try {
      for (const role of dirtyRoles) {
        const permissions = [...grantsFor(role)];
        await update.mutateAsync({ id: role.id, input: { permissions } });
        saved += 1;
        setEdits((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => id !== role.id)),
        );
      }
      toast.success(saved === 1 ? 'One role saved' : `${formatNumber(saved)} roles saved`);
    } catch (error) {
      toast.error(
        saved === 0
          ? 'The report was not saved'
          : `${formatNumber(saved)} of ${formatNumber(dirtyRoles.length)} roles saved before an error`,
        { description: describeError(error) },
      );
    } finally {
      setSaving(false);
    }
  };

  // Per module: which permissions each role column may hold.
  const sections = modules
    .map((module) => ({
      ...module,
      byRole: roles.map((role) =>
        module.permissions.filter((permission) => permissionAppliesTo(permission, role.kind)),
      ),
    }))
    .filter((module) => module.byRole.some((list) => list.length > 0));

  const stickyCell = 'sticky left-0 z-10 bg-surface';

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tick a box to grant that permission to the role. Global permissions apply to global roles
        and the rest to project roles, so some cells stay empty.
      </p>

      {/* Bounded so the role headings stay in view while the long list of
          permissions scrolls beneath them; the corner cell sits above both
          sticky axes so neither slides under it. */}
      <TableCard maxHeight="calc(100dvh - 22rem)">
        <Table className="min-w-max">
          <TableHeader sticky>
            <TableRow>
              <TableHead className={cn(stickyCell, 'z-20 min-w-64 bg-surface-sunken')}>
                Permission
              </TableHead>
              {roles.map((role) => {
                const changed = dirtyRoles.some((item) => item.id === role.id);
                return (
                  <TableHead
                    key={role.id}
                    className="min-w-28 max-w-40 align-bottom normal-case tracking-normal"
                  >
                    <span className="flex flex-col items-start gap-1 py-2">
                      <Link
                        to={`${ROLES_PATH}/${role.id}`}
                        className="rounded text-xs font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {role.name}
                        {changed ? (
                          <span className="text-warning" aria-hidden>
                            {' *'}
                          </span>
                        ) : null}
                        {changed ? <span className="sr-only"> (unsaved)</span> : null}
                      </Link>
                      <Badge tone="neutral" size="sm">
                        {ROLE_KIND_LABEL[role.kind]}
                      </Badge>
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          {sections.map((module) => {
            const isCollapsed = Boolean(collapsed[module.id]);
            const rowsId = `report-${module.id}`;
            const allInSection = module.byRole.flatMap((list, index) =>
              list.map((permission) => ({
                roleId: roles[index].id,
                name: permission.name,
              })),
            );
            const grantedInSection = allInSection.filter(({ roleId, name }) => {
              const role = serverById.get(roleId);
              return role ? grantsFor(role).has(name) : false;
            }).length;

            return (
              <TableBody key={module.id} id={rowsId}>
                <TableRow className="bg-surface-sunken/40">
                  <TableCell className={cn(stickyCell, 'bg-surface-sunken/40 py-2')}>
                    <PermissionSectionHeader
                      id={rowsId}
                      label={module.label}
                      checked={grantedInSection}
                      total={allInSection.length}
                      collapsed={isCollapsed}
                      onToggle={() => toggleCollapsed(module.id)}
                      onCheckAll={() =>
                        apply(
                          module.byRole.map((list, index) => ({
                            roleId: roles[index].id,
                            names: list.map((item) => item.name),
                            value: true,
                          })),
                        )
                      }
                      onUncheckAll={() =>
                        apply(
                          module.byRole.map((list, index) => ({
                            roleId: roles[index].id,
                            names: list.map((item) => item.name),
                            value: false,
                          })),
                        )
                      }
                      disabled={saving}
                    />
                  </TableCell>
                  {roles.map((role, index) => {
                    const list = module.byRole[index];
                    if (list.length === 0) return <TableCell key={role.id} className="py-2" />;
                    const grants = grantsFor(role);
                    const granted = list.filter((item) => grants.has(item.name)).length;
                    const state =
                      granted === 0 ? false : granted === list.length ? true : 'indeterminate';
                    return (
                      <TableCell key={role.id} className="py-2 text-center">
                        <Checkbox
                          checked={state}
                          disabled={saving}
                          aria-label={`All ${module.label} permissions for ${role.name}`}
                          onCheckedChange={(checked) =>
                            apply([
                              {
                                roleId: role.id,
                                names: list.map((item) => item.name),
                                value: checked === true,
                              },
                            ])
                          }
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>

                {isCollapsed
                  ? null
                  : module.permissions.map((permission) => (
                      <TableRow key={permission.name}>
                        <TableCell className={cn(stickyCell, 'py-2')}>
                          <span className="block">{permission.label}</span>
                          {permission.explanation ? (
                            <span className="block text-2xs italic text-muted-foreground">
                              {permission.explanation}
                            </span>
                          ) : null}
                        </TableCell>
                        {roles.map((role) => {
                          if (!permissionAppliesTo(permission, role.kind)) {
                            return <TableCell key={role.id} className="py-2" />;
                          }
                          return (
                            <TableCell key={role.id} className="py-2 text-center">
                              <Checkbox
                                checked={grantsFor(role).has(permission.name)}
                                disabled={saving}
                                aria-label={`${permission.label} for ${role.name}`}
                                onCheckedChange={(checked) =>
                                  apply([
                                    {
                                      roleId: role.id,
                                      names: [permission.name],
                                      value: checked === true,
                                    },
                                  ])
                                }
                              />
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
              </TableBody>
            );
          })}
        </Table>
      </TableCard>

      <div
        className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 shadow-elevated"
        role="region"
        aria-label="Save changes"
      >
        <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={reset} disabled={!dirty || saving}>
          Reset
        </Button>
        <p className="ml-auto text-2xs text-muted-foreground" aria-live="polite">
          {dirty
            ? `${formatNumber(dirtyRoles.length)} ${pluralize(dirtyRoles.length, 'role')} with unsaved changes`
            : 'No unsaved changes'}
        </p>
      </div>
    </div>
  );
}
