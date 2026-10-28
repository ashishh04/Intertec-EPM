import { forgetPermissions } from '../auth/capabilities.js';
import { isStoredRole, ROLE_TEXT, type AssignableRole } from '../auth/roles.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message, type Message } from '../lib/i18n.js';
import { withAudit } from './audit.js';
import { forgetExternal } from './external-access.js';

/**
 * Giving someone an EPM role: Manager, HR, Employee or External
 * (`auth/roles.ts`).
 *
 * One function for every screen that sets a role — Access roles, and editing
 * or adding a user — so the rules, the journal entry and the caches cannot
 * differ between them. Administrators are set on the account, never here; the
 * callers refuse them before calling.
 *
 * External is the profile's `external` flag: the portal gate's own switch, and
 * the one granting external access sets. Making someone external keeps their
 * stored internal role, which is where they return if the External users page
 * later makes them internal again. Making them internal is refused while they
 * still hold external access to a project, as it is there: removing that
 * access is what takes away their membership of the project.
 */

/** The role someone holds now, as far as this function is concerned (not administrator). */
export async function assignedRole(userId: string): Promise<AssignableRole> {
  const profile = await prisma.userProfile.findUnique({
    where: { openProjectId: userId },
    select: { appRole: true, external: true },
  });
  if (profile?.external) return 'external';
  return isStoredRole(profile?.appRole) ? profile.appRole : 'employee';
}

/** Sets the role, journalled. Returns whether anything changed. */
export async function assignRole(input: {
  userId: string;
  personName: string | Message;
  role: AssignableRole;
  actorId: string;
}): Promise<boolean> {
  const { userId, personName, role, actorId } = input;
  const before = await assignedRole(userId);
  if (before === role) return false;

  if (role === 'external' && userId === actorId) throw EpmError.validation('You cannot make yourself external.');
  if (before === 'external' && (await prisma.externalAccess.count({ where: { userId } })) > 0) {
    throw EpmError.conflict(
      message('{person} still has external access to projects. Remove it on the External users page first.', {
        person: personName,
      }),
    );
  }

  const data =
    role === 'external'
      ? { external: true }
      : // Employee is the default, so it is stored as nothing rather than as a value.
        { external: false, appRole: role === 'employee' ? null : role };

  await withAudit(
    (tx) =>
      tx.userProfile.upsert({
        where: { openProjectId: userId },
        create: { openProjectId: userId, ...data },
        update: data,
      }),
    {
      actorId,
      entityType: 'app_role',
      entityId: userId,
      action: 'role.changed',
      summary: message('Made {name} {role}', { name: personName, role: ROLE_TEXT[role].label }),
      before: { role: before },
      after: { role },
    },
  );

  // At once on this server: the portal gate and the permissions are both
  // cached briefly, and a role change should not wait them out.
  forgetExternal(userId);
  forgetPermissions(userId);
  return true;
}
