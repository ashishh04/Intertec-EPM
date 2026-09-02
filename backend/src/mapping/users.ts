import { openProject, linkId, linkTitle } from '../openproject/client.js';
import { referenceCache } from '../lib/cache.js';
import { optional, prisma } from '../db/prisma.js';
import type { OpMembership, OpPrincipal } from '../openproject/types.js';
import type { AvatarAccent, ID, EpmUser } from '../types/epm.js';

/**
 * People.
 *
 * `/users` is admin-only and returns 403 for a normal token, so principals are
 * the general source. They carry only id, name and avatar — no email, and no
 * account status for anyone but the caller. Those fields are therefore left
 * empty rather than invented; `/users/me` is used for the signed-in user, where
 * the full record is available.
 */

const ACCENTS: AvatarAccent[] = ['blue', 'teal', 'violet', 'amber', 'rose', 'slate'];

/** Stable per-user colour, so an avatar keeps the same accent across sessions. */
function accentFor(id: ID): AvatarAccent {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100_000;
  }
  return ACCENTS[hash % ACCENTS.length] as AvatarAccent;
}

export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0] ?? ''}${(words[words.length - 1] as string)[0] ?? ''}`.toUpperCase();
}

interface UserOverlay {
  department?: string | null;
  timezone?: string | null;
}

export function toEpmUser(
  principal: OpPrincipal,
  options: { role?: string; overlay?: UserOverlay } = {},
): EpmUser {
  const id = String(principal.id);

  return {
    id,
    name: principal.name,
    initials: initialsFor(principal.name),
    // Principals do not expose email to a non-admin token.
    email: principal.email ?? '',
    role: options.role ?? '',
    department: options.overlay?.department ?? '',
    avatarUrl: principal.avatar,
    // OpenProject has no presence concept. `status` is an account state, not
    // whether someone is online, so it is not reported as presence.
    status: 'offline',
    timezone: options.overlay?.timezone ?? '',
    accent: accentFor(id),
  };
}

/** Project roles per user, derived from memberships. */
async function loadRoles(signal?: AbortSignal): Promise<Map<string, string>> {
  const memberships = await openProject.getAll<OpMembership>(
    '/memberships',
    { pageSize: 100 },
    { signal },
  );

  const roles = new Map<string, string>();
  for (const membership of memberships.items) {
    const principalId = linkId(membership._links, 'principal');
    if (!principalId || roles.has(principalId)) continue;

    const roleLinks = membership._links?.roles;
    const first = Array.isArray(roleLinks) ? roleLinks[0] : roleLinks;
    if (first?.title) roles.set(principalId, first.title);
  }

  return roles;
}

async function loadUsers(signal?: AbortSignal): Promise<EpmUser[]> {
  const [principals, roles] = await Promise.all([
    openProject.getAll<OpPrincipal>('/principals', { pageSize: 100 }, { signal }),
    loadRoles(signal).catch(() => new Map<string, string>()),
  ]);

  const overlays = await optional(
    () => prisma.userProfile.findMany(),
    [] as { openProjectId: string; department: string | null; timezone: string | null }[],
  );
  const overlayById = new Map(overlays.map((row) => [row.openProjectId, row]));

  return principals.items
    .filter((principal) => principal._type !== 'Group' && principal._type !== 'PlaceholderUser')
    .map((principal) =>
      toEpmUser(principal, {
        role: roles.get(String(principal.id)),
        overlay: overlayById.get(String(principal.id)),
      }),
    );
}

export function getUsers(signal?: AbortSignal): Promise<EpmUser[]> {
  return referenceCache.get('users', () => loadUsers(signal), 5 * 60_000);
}

/** The signed-in user, where OpenProject does return the full record. */
export async function getCurrentUser(signal?: AbortSignal): Promise<EpmUser> {
  const me = await openProject.request<OpPrincipal>('/users/me', { signal });

  const overlay = await optional(
    () => prisma.userProfile.findUnique({ where: { openProjectId: String(me.id) } }),
    null,
  );

  const roles = await loadRoles(signal).catch(() => new Map<string, string>());

  return toEpmUser(me, {
    role: roles.get(String(me.id)) ?? (me.admin ? 'Administrator' : ''),
    overlay: overlay ?? undefined,
  });
}

export { linkTitle };
