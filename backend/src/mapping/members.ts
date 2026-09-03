import { idFromHref, linkId } from '../openproject/client.js';
import type { HalLink, OpMembership, OpPrincipal, OpRole } from '../openproject/types.js';
import type { EpmMemberCandidate, EpmProjectMember, EpmRole } from '../types/epm.js';

/**
 * Project membership, translated from OpenProject.
 *
 * A membership is the association, not the person: it carries its own id, and
 * that id — not the user's — is what a role change or a removal acts on.
 * Conflating the two is the easiest way to remove the wrong person, so both
 * travel together in the contract.
 *
 * Nothing here is stored. Memberships live entirely in OpenProject, which is
 * where projects and users live; EPM reads and writes them through and keeps no
 * copy to fall out of date.
 */

/** `_links.roles` is an array of links, each already carrying its title. */
function toEpmRoles(links: HalLink | HalLink[] | undefined): EpmRole[] {
  const list = Array.isArray(links) ? links : links ? [links] : [];

  return list
    .map((link) => ({ id: idFromHref(link.href) ?? '', name: link.title ?? '' }))
    .filter((role) => role.id !== '');
}

/**
 * `canManage` is passed in rather than read from `_links`.
 *
 * OpenProject publishes `update` and `updateImmediately` on a membership but
 * **no `delete`**, even where the caller is permitted to delete it — verified
 * against 15.5.1 by creating a membership and reading back its links. So the
 * affordance pattern used for watchers, relations and comments has nothing to
 * key on here, and the honest signal is the per-project `member:manage`
 * capability the caller already holds. Inventing an affordance that upstream
 * does not publish would be worse than using the capability plainly.
 */
export function toEpmProjectMember(
  membership: OpMembership,
  canManage: boolean,
): EpmProjectMember {
  return {
    membershipId: String(membership.id),
    userId: linkId(membership._links, 'principal') ?? '',
    roles: toEpmRoles(membership._links?.roles),
    canManage,
    createdAt: membership.createdAt,
  };
}

export function toEpmRole(role: OpRole): EpmRole {
  return { id: String(role.id), name: role.name };
}

export function toEpmMemberCandidate(principal: OpPrincipal): EpmMemberCandidate {
  return { userId: String(principal.id), name: principal.name ?? '' };
}
