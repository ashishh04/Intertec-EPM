import { openProject } from '../openproject/client.js';
import {
  emptyPermissions,
  grantFromAction,
  type Permission,
  type PermissionSet,
} from './permissions.js';

/**
 * Effective permissions for the signed-in user, read from OpenProject.
 *
 * Capabilities are reported per (action, context, principal). Context is either
 * a project or global, so the same user can hold `work_packages/update` in one
 * project and not in another. That distinction is preserved here rather than
 * flattened, because flattening it is exactly how a user ends up able to edit a
 * project they only have read access to.
 *
 * Everything is fetched with the caller's own token, so OpenProject decides what
 * it will admit to — this cannot report more than the user actually has.
 */

interface OpCapability {
  id: string;
  _links: {
    action?: { href?: string };
    context?: { href?: string; title?: string };
    principal?: { href?: string };
  };
}

export interface EffectivePermissions {
  /** Permissions that hold regardless of project. */
  global: PermissionSet;
  /** Project id -> permissions within that project. */
  byProject: Map<string, PermissionSet>;
}

function actionOf(capability: OpCapability): string | undefined {
  // "/api/v3/actions/work_packages/update" -> "work_packages/update"
  const href = capability._links.action?.href;
  return href?.split('/api/v3/actions/')[1];
}

function projectOf(capability: OpCapability): string | undefined {
  const href = capability._links.context?.href;
  if (!href?.startsWith('/api/v3/projects/')) return undefined;
  return href.slice('/api/v3/projects/'.length);
}

/**
 * Reads every capability OpenProject reports for a user.
 *
 * A failure here resolves to "no permissions" rather than throwing. Denying
 * everything degrades the UI to read-only; letting the error propagate would
 * take down the session entirely, and guessing would be worse than both.
 */
export async function loadPermissions(
  userId: string,
  signal?: AbortSignal,
): Promise<EffectivePermissions> {
  const global = emptyPermissions();
  const byProject = new Map<string, PermissionSet>();

  let items: OpCapability[] = [];
  try {
    const response = await openProject.getAll<OpCapability>(
      '/capabilities',
      {
        filters: [{ field: 'principal', operator: '=', values: [userId] }],
        pageSize: 200,
      },
      { signal },
    );
    items = response.items;
  } catch {
    return { global, byProject };
  }

  for (const capability of items) {
    const action = actionOf(capability);
    if (!action) continue;

    const projectId = projectOf(capability);

    if (projectId === undefined) {
      grantFromAction(global, action);
      continue;
    }

    let set = byProject.get(projectId);
    if (!set) {
      set = emptyPermissions();
      byProject.set(projectId, set);
    }
    grantFromAction(set, action);
  }

  return { global, byProject };
}

/**
 * Whether a permission holds, in a project when one is given.
 *
 * A project-scoped question is answered only by that project's capabilities.
 * Global permissions are not folded in: `projects/create` being global must not
 * make a user look like an editor of every project.
 */
export function allows(
  permissions: EffectivePermissions,
  permission: Permission,
  projectId?: string,
): boolean {
  if (projectId === undefined) return permissions.global[permission] === true;
  return permissions.byProject.get(projectId)?.[permission] === true;
}

/**
 * Union of global and every project permission.
 *
 * Only for "should this navigation entry exist at all" questions. Never for
 * authorising an operation — use `allows` with the target project for that.
 */
export function anywhere(permissions: EffectivePermissions, permission: Permission): boolean {
  if (permissions.global[permission]) return true;
  for (const set of permissions.byProject.values()) {
    if (set[permission]) return true;
  }
  return false;
}
