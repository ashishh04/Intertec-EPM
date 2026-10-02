import { openProject, linkId, linkTitle, MAX_PAGE_SIZE } from '../openproject/client.js';
import { referenceCache, userScopedKey } from '../lib/cache.js';
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
  /** Legacy free text. Only used when a person has no department mapping. */
  department?: string | null;
  /** The mapped department's name, which supersedes the free text above. */
  departmentRef?: { name: string } | null;
  timezone?: string | null;
}

export function toEpmUser(
  principal: OpPrincipal,
  options: { role?: string; overlay?: UserOverlay; timezone?: string } = {},
): EpmUser {
  const id = String(principal.id);

  return {
    id,
    name: principal.name,
    firstName: principal.firstName ?? '',
    lastName: principal.lastName ?? '',
    initials: initialsFor(principal.name),
    // Principals do not expose email to a non-admin token.
    email: principal.email ?? '',
    /*
     * An instance administrator is reported as one, whatever their project
     * memberships say.
     *
     * The alternative — the first role of the first membership found — is both
     * misleading and unstable where it is read most: under someone's own name
     * in the account menu, which answers "who am I". An administrator who
     * happens to be a Member of one project showed as "Member", and would
     * change to something else the moment that membership did. Administrator is
     * a property of the account, so it does not move.
     *
     * Groups and placeholders report nothing here, which is correct: `admin` is
     * undefined on them, and neither holds a project role either.
     */
    role: principal.admin ? 'Administrator' : (options.role ?? ''),
    // The mapping is authoritative. The free-text column is a fallback for a
    // deployment that populated it before employee mapping existed; this one
    // never did. Neither is invented — an unmapped person reports nothing.
    department: options.overlay?.departmentRef?.name ?? options.overlay?.department ?? '',
    // EPM's own path, not the absolute upstream URL the principal carries:
    // that would name the system behind EPM in every page that shows a face.
    avatarUrl: principal.avatar ? `/users/${id}/avatar` : '',
    // OpenProject has no presence concept. `status` is an account state, not
    // whether someone is online, so it is not reported as presence.
    status: 'offline',
    timezone: options.timezone ?? options.overlay?.timezone ?? '',
    // Only ever on the person's own record: `/principals` does not publish it,
    // so this is empty for everybody in the directory listing — which is right,
    // because nothing shows another person's language.
    language: principal.language ?? '',
    accent: accentFor(id),
  };
}

/**
 * Project roles per user, derived from memberships.
 *
 * Cached, because it walks the whole membership collection and is needed by both
 * the directory and the signed-in person's own record — so it was being fetched
 * twice over on pages that show both, and once more on every subsequent request.
 * Keyed under `users`, so the invalidation the profile write already performs
 * clears it along with everything else derived from the directory.
 */
function loadRoles(signal?: AbortSignal): Promise<Map<string, string>> {
  return referenceCache.get(userScopedKey('users:roles'), () => readRoles(signal), 5 * 60_000);
}

async function readRoles(signal?: AbortSignal): Promise<Map<string, string>> {
  const memberships = await openProject.getAll<OpMembership>(
    '/memberships',
    { pageSize: MAX_PAGE_SIZE },
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
    openProject.getAll<OpPrincipal>('/principals', { pageSize: MAX_PAGE_SIZE }, { signal }),
    loadRoles(signal).catch(() => new Map<string, string>()),
  ]);

  const overlays = await optional(
    () => prisma.userProfile.findMany({ include: { departmentRef: { select: { name: true } } } }),
    [] as {
      openProjectId: string;
      department: string | null;
      departmentRef: { name: string } | null;
      timezone: string | null;
    }[],
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
  return referenceCache.get(userScopedKey('users'), () => loadUsers(signal), 5 * 60_000);
}

/** The signed-in user, where OpenProject does return the full record. */
/**
 * The signed-in person's own preferences, for the handful of fields EPM shows.
 *
 * A separate call because a principal does not carry them. Failure is not
 * fatal: the profile is still worth rendering without a timezone, so this
 * reports nothing rather than taking the page down with it.
 */
async function myPreferences(signal?: AbortSignal): Promise<{ timeZone?: string }> {
  return openProject
    .request<{ timeZone?: string }>('/users/me/preferences', { signal })
    .catch(() => ({}));
}

/**
 * The signed-in person's own record.
 *
 * Cached for a minute. This is four upstream calls — the account, its
 * preferences, the EPM overlay and the membership walk — and it was being made
 * afresh on every request that needed to know who is asking, which is most of
 * them. Under the `users` prefix, so saving a profile clears it immediately and
 * the person sees their own change rather than waiting out the TTL.
 */
export function getCurrentUser(signal?: AbortSignal): Promise<EpmUser> {
  return referenceCache.get(userScopedKey('users:me'), () => readCurrentUser(signal), 60_000);
}

async function readCurrentUser(signal?: AbortSignal): Promise<EpmUser> {
  const [me, preferences] = await Promise.all([
    openProject.request<OpPrincipal>('/users/me', { signal }),
    myPreferences(signal),
  ]);

  const overlay = await optional(
    () =>
      prisma.userProfile.findUnique({
        where: { openProjectId: String(me.id) },
        include: { departmentRef: { select: { name: true } } },
      }),
    null,
  );

  const roles = await loadRoles(signal).catch(() => new Map<string, string>());

  return toEpmUser(me, {
    // Just the membership role; `toEpmUser` decides whether being an
    // administrator outranks it. This used to fall back to Administrator only
    // when no membership existed, which meant an administrator who belonged to
    // a single project reported that project's role instead.
    role: roles.get(String(me.id)) ?? '',
    overlay: overlay ?? undefined,
    // The instance is the authority; the EPM column is a fallback for a
    // deployment that populated it before this was read from upstream.
    timezone: preferences.timeZone ?? undefined,
  });
}

export { linkTitle };
