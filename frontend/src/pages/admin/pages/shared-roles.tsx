import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AdminPermission, AdminRole, AdminRoleKind } from '@/services/api/admin';
import { cn } from '@/lib/utils';

/**
 * What the Roles page and the Permissions report agree on: how roles are
 * ordered and labelled, which permissions a kind of role may hold, and the
 * section header that sits above a module's permissions on both pages.
 */

/** Where the roles list lives. Its editor is `${ROLES_PATH}/:id` or `${ROLES_PATH}/new`. */
export const ROLES_PATH = '/admin/users/roles';

export const ROLE_KIND_LABEL: Record<AdminRoleKind, string> = {
  project: 'Project role',
  global: 'Global role',
  work_package: 'Work package role',
  project_query: 'Project query role',
};

const KIND_ORDER: Record<AdminRoleKind, number> = {
  project: 0,
  global: 1,
  work_package: 2,
  project_query: 3,
};

/** Project roles first, by position, then global roles, then the rest. */
export function sortRoles(roles: readonly AdminRole[]): AdminRole[] {
  return [...roles].sort((a, b) => {
    const byKind = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (byKind !== 0) return byKind;
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Only project and global roles carry permissions an administrator sets. */
export function isEditableRole(role: Pick<AdminRole, 'kind'>): boolean {
  return role.kind === 'project' || role.kind === 'global';
}

/**
 * Which permissions a kind of role may hold.
 *
 * The instance answers this: `grantTo` is read from the same role contract
 * that validates a create, so what the form offers and what a create accepts
 * cannot drift.
 *
 * The fallback below is what this used to do on its own, and it was wrong in
 * one direction. "Not global" is not the same as "grantable to a project
 * role": `view_project_query` and `edit_project_query` belong to a project
 * query role and to nothing else, so the form offered them under Project,
 * "Check all" selected them, and every submission came back "These permissions
 * cannot be given to this role". It stays only so an instance running an older
 * copy of the plugin degrades to the previous behaviour rather than showing an
 * empty form.
 */
export function permissionAppliesTo(permission: AdminPermission, kind: AdminRoleKind): boolean {
  if (permission.grantTo) return permission.grantTo.includes(kind);
  if (kind === 'global') return permission.global;
  if (kind === 'project') return !permission.global;
  return false;
}

export function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

/** "Check all | Uncheck all", the way OpenProject offers it beside each module. */
export function CheckAllLinks({
  onCheckAll,
  onUncheckAll,
  scope,
  disabled,
}: {
  onCheckAll: () => void;
  onUncheckAll: () => void;
  /** Read out to screen readers, e.g. "Work packages permissions". */
  scope: string;
  disabled?: boolean;
}) {
  const link =
    'rounded text-2xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <button type="button" className={link} onClick={onCheckAll} disabled={disabled}>
        Check all<span className="sr-only"> {scope}</span>
      </button>
      <span className="text-2xs text-muted-foreground" aria-hidden>
        |
      </span>
      <button type="button" className={link} onClick={onUncheckAll} disabled={disabled}>
        Uncheck all<span className="sr-only"> {scope}</span>
      </button>
    </span>
  );
}

/**
 * The uppercase heading above one module's permissions, with a collapse
 * toggle on the left and Check all | Uncheck all on the right.
 */
export function PermissionSectionHeader({
  id,
  label,
  checked,
  total,
  collapsed,
  onToggle,
  onCheckAll,
  onUncheckAll,
  disabled,
  className,
}: {
  id: string;
  label: string;
  checked: number;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  onCheckAll: () => void;
  onUncheckAll: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={id}
        className="flex min-w-0 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="epm-eyebrow truncate text-foreground">{label}</span>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {checked}/{total}
        </span>
      </button>
      <CheckAllLinks
        scope={`${label} permissions`}
        onCheckAll={onCheckAll}
        onUncheckAll={onUncheckAll}
        disabled={disabled}
      />
    </div>
  );
}
