import { runAsAutomation, runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { openProject } from '../openproject/client.js';
import { recordAuditQuietly } from './audit.js';

/**
 * EPM's automation account: the service principal rules act as (BR-217, NFR06).
 *
 * An OpenProject user that nobody signs in as, holding its own API key and,
 * in each project a rule acts in, one role — "EPM Automation" — with only the
 * permissions rule actions need. Not an administrator: it is made a member of
 * a project the first time a rule acts there, by the system key, and the
 * journal says so. `backend/openproject/setup/automation-account.rb` creates
 * the user, the role and the key.
 */

export const AUTOMATION_ROLE_NAME = 'EPM Automation';

export interface AutomationIdentity {
  id: string;
  name: string;
  /** An administrator needs no memberships. Not recommended, but honoured. */
  admin: boolean;
}

export function automationConfigured(): boolean {
  return Boolean(env.OPENPROJECT_AUTOMATION_API_KEY);
}

let identity: Promise<AutomationIdentity | null> | undefined;

/**
 * Who the automation key belongs to, or null when it is not configured or
 * does not work. Cached; a failure is not, so a key fixed later is picked up.
 */
export function automationIdentity(): Promise<AutomationIdentity | null> {
  if (!automationConfigured()) return Promise.resolve(null);
  identity ??= runAsAutomation(() =>
    openProject.request<{ id: number; name?: string; admin?: boolean }>('/users/me', { timeoutMs: 10_000 }),
  )
    .then((me) => ({ id: String(me.id), name: me.name ?? 'EPM Automation', admin: me.admin === true }))
    .catch((error: unknown) => {
      identity = undefined;
      appLog.warn({ err: error }, 'The automation account key did not work');
      return null;
    });
  return identity;
}

/** The automation account's user id, for keeping it out of lists of people. */
export async function automationUserId(): Promise<string | undefined> {
  return (await automationIdentity())?.id;
}

let roleId: Promise<string | null> | undefined;

function automationRoleId(): Promise<string | null> {
  roleId ??= runAsSystem(() => openProject.getAll<{ id: number; name: string }>('/roles', { pageSize: 200 }))
    .then((roles) => {
      const role = roles.items.find((candidate) => candidate.name === AUTOMATION_ROLE_NAME);
      return role ? String(role.id) : null;
    })
    .catch(() => {
      roleId = undefined;
      return null;
    });
  return roleId;
}

/** Projects the account is known to be a member of, so each is asked about once. */
const memberOf = new Set<string>();

/** Joins under way in this process, so callers acting at once share one. */
const joining = new Map<string, Promise<void>>();

/**
 * Makes the automation account a member of a project before a rule acts there.
 *
 * Done with the system key, which can manage memberships everywhere; the
 * account itself cannot, by design. Silent to the account (no "you were added"
 * mail) and journalled on the project, because a new member is a change to it.
 *
 * Callers in this process acting on the same project at once (a rule and a
 * recurring series, say) share one attempt. A second server may still race this
 * one to the same project; whichever loses finds the membership the other made
 * and carries on.
 */
export async function ensureAutomationMembership(projectId: string): Promise<void> {
  const me = await automationIdentity();
  if (!me) throw new Error('The automation account is not configured.');
  if (me.admin || memberOf.has(projectId)) return;

  const underway = joining.get(projectId);
  if (underway) return underway;
  const attempt = joinProject(me, projectId).finally(() => joining.delete(projectId));
  joining.set(projectId, attempt);
  return attempt;
}

async function joinProject(me: { id: string; name: string }, projectId: string): Promise<void> {
  await runAsSystem(async () => {
    const isMember = async () => {
      const existing = await openProject.getCollection<unknown>('/memberships', {
        filters: [
          { field: 'project', operator: '=', values: [projectId] },
          { field: 'principal', operator: '=', values: [me.id] },
        ],
        pageSize: 1,
      });
      return (existing.total ?? 0) > 0;
    };
    if (await isMember()) {
      memberOf.add(projectId);
      return;
    }

    const role = await automationRoleId();
    if (!role) {
      throw new Error(`There is no "${AUTOMATION_ROLE_NAME}" role on the instance. Run automation-account.rb.`);
    }
    try {
      await openProject.request('/memberships', {
        method: 'POST',
        body: {
          _links: {
            project: { href: `/api/v3/projects/${projectId}` },
            principal: { href: `/api/v3/users/${me.id}` },
            roles: [{ href: `/api/v3/roles/${role}` }],
          },
          _meta: { sendNotifications: false },
        },
      });
    } catch (error) {
      // Another server made the membership between the check and the POST.
      if (await isMember().catch(() => false)) {
        memberOf.add(projectId);
        return;
      }
      throw error;
    }
    memberOf.add(projectId);
    await recordAuditQuietly([
      {
        actorId: null,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'automation.membership.added',
        summary: message('{name} was made a member of this project, with the {role} role, so a rule could act here.', {
          name: me.name,
          role: AUTOMATION_ROLE_NAME,
        }),
      },
    ]);
  });
}

/** For the status card: configured, working, and as whom. */
export async function automationStatus(): Promise<{
  configured: boolean;
  working: boolean;
  userId?: string;
  name?: string;
  admin?: boolean;
  roleFound: boolean;
}> {
  if (!automationConfigured()) return { configured: false, working: false, roleFound: false };
  const me = await automationIdentity();
  const role = me && !me.admin ? await automationRoleId() : null;
  return {
    configured: true,
    working: Boolean(me),
    userId: me?.id,
    name: me?.name,
    admin: me?.admin,
    roleFound: Boolean(me?.admin || role),
  };
}
