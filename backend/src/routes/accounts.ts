import { randomInt } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { referenceCache } from '../lib/cache.js';
import { requestSignal } from '../lib/request-signal.js';
import { checkPassword } from '../domain/password-policy.js';
import { setCapacity, setMapping } from '../domain/employees.js';
import { createInvite, inviteUrl } from '../email/invites.js';
import { enqueueEmail } from '../email/outbox.js';
import { forgetRecipient } from '../email/recipients.js';
import { toEpmAccount } from '../mapping/accounts.js';
import { getCurrentUser } from '../mapping/users.js';
import { linkId, linkTitle, openProject } from '../openproject/client.js';
import type { OpMembership, OpPrincipal } from '../openproject/types.js';
import type { AccountRevocation, EpmAccount } from '../types/epm.js';

/**
 * User accounts.
 *
 * Accounts are OpenProject's. Every write here goes straight through and EPM
 * stores nothing about the person — no shadow user table, and no id EPM minted.
 *
 * What EPM adds is the second half of the create flow: OpenProject's own new
 * user form cannot capture a department, a team or a weekly capacity, because
 * it has no such concepts. Creating someone here does both in one step, which
 * is the reason this belongs in EPM rather than being a link to the admin
 * console.
 *
 * Authorisation splits by operation, following whichever signal OpenProject
 * actually publishes:
 *
 * - **create** — the global `users:manage` permission, which `ACTION_GRANTS`
 *   already derives from OpenProject's `users/create` and `users/update`
 *   capabilities. No new permission is invented.
 * - **update, lock, unlock, delete** — the affordances on the account itself.
 *   OpenProject varies these by state and reports no capability for any of
 *   them, so the resource is the only honest source. `delete` in particular is
 *   absent unless the instance permits admins to delete users at all.
 */

/** Reads one account, or reports it missing. */
async function accountOf(request: FastifyRequest, id: string): Promise<OpPrincipal> {
  if (!/^\d+$/.test(id)) throw EpmError.notFound('That person');

  const account = await openProject
    .request<OpPrincipal>(`/users/${id}`, { signal: requestSignal(request) })
    .catch(() => null);

  if (!account) throw EpmError.notFound('That person');
  return account;
}

/**
 * Refuses unless OpenProject offered the operation on this very account.
 *
 * Checked against a freshly read resource rather than one the client sent, so a
 * caller cannot assert their own permission.
 */
function requireAffordance(
  account: OpPrincipal,
  link: 'updateImmediately' | 'lock' | 'unlock' | 'delete',
  message: string,
): void {
  if (!account._links || !Object.hasOwn(account._links, link)) throw EpmError.forbidden(message);
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * A starting password nobody will ever type.
 *
 * Made only when an invitation is being sent, so the account can be created
 * active — upstream requires a password for that — while the person sets
 * their own through the invite link. One character from each class, so it
 * passes whatever rules the instance enforces; never returned, never logged.
 */
function generatePassword(): string {
  const classes = [
    'abcdefghijkmnopqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    '23456789',
    '!@#$%^&*-_=+',
  ];
  const all = classes.join('');

  const chars = classes.map((set) => set[randomInt(set.length)]!);
  while (chars.length < 24) chars.push(all[randomInt(all.length)]!);

  // Fisher–Yates, so the guaranteed characters are not always the first four.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join('');
}

/** Rejects a payload upstream would reject anyway, with a clearer message. */
function requireCreateFields(
  body: Record<string, unknown>,
  options: { passwordRequired: boolean },
): {
  login: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
} {
  const login = text(body.login);
  const firstName = text(body.firstName);
  const lastName = text(body.lastName);
  const email = text(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const missing = [
    ['a username', login],
    ['a first name', firstName],
    ['a last name', lastName],
    ['an email address', email],
    ['a starting password', options.passwordRequired ? password : 'not needed'],
  ]
    .filter(([, value]) => !value)
    .map(([label]) => label as string);

  if (missing.length > 0) {
    throw EpmError.badRequest(`Creating a person needs ${missing.join(', ')}.`);
  }

  // Not a full RFC check — OpenProject validates properly and its message is
  // the one worth showing. This only catches the obviously wrong.
  if (!email.includes('@')) throw EpmError.badRequest('That email address is not valid.');

  return { login, firstName, lastName, email, password };
}

/**
 * Mints a token for the account and queues the invitation email. True when a
 * row was written to the outbox; false when the email could not be queued —
 * which `enqueueEmail` has already logged with the reason.
 */
async function sendInvitation(input: {
  account: OpPrincipal;
  createdBy: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const id = String(input.account.id);
  const email = input.account.email?.trim() ?? '';
  if (!email) throw EpmError.badRequest('This person has no email address to invite.');

  // Named in the email, so the person knows who to ask if the link expires.
  const invitedBy = await getCurrentUser(input.signal)
    .then((user) => user.name)
    .catch(() => 'Your administrator');

  const { token, expiresAt } = await createInvite({ openProjectId: id, email, createdBy: input.createdBy });

  const outcome = await enqueueEmail({
    recipientId: id,
    template: 'invite',
    payload: {
      firstName: input.account.firstName?.trim() || input.account.name,
      inviteUrl: inviteUrl(token),
      expiresAt: expiresAt.toISOString(),
      invitedBy,
    },
    channel: 'immediate',
  });

  return outcome === 'queued';
}

export const accountRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The account directory.
   *
   * Behind `users:manage` rather than a read permission: `/users` upstream is
   * admin-only and 403s for anyone else, and this carries logins, emails and
   * account state that the ordinary `/users` directory deliberately omits.
   */
  app.get('/accounts', async (request) => {
    await guard.require(request, 'users:manage');

    const collection = await openProject.getAll<OpPrincipal>(
      '/users',
      { pageSize: 100 },
      { signal: requestSignal(request) },
    );

    return collection.items.map(toEpmAccount).sort((a, b) => a.name.localeCompare(b.name));
  });

  app.get<{ Params: { id: string } }>('/accounts/:id', async (request) => {
    await guard.require(request, 'users:manage');
    return toEpmAccount(await accountOf(request, request.params.id));
  });

  /**
   * Creates a person, and optionally places them in the organisation.
   *
   * The account is created **active with a starting password**, so the person
   * can sign in the moment they are told it.
   *
   * An earlier version created them as `invited`, which is what the upstream
   * admin form does and needs no password — but that relies on an invitation
   * email, and this deployment has no mail transport configured. Every account
   * made that way was unreachable: no password, no mail, no way in. A working
   * account the administrator can hand over beats a tidier flow that produces
   * nobody who can log in.
   *
   * The password is validated upstream against the instance's own rules, is
   * never stored by EPM, never logged, and never echoed back in the response.
   *
   * With `sendInvite` (the default now that EPM has an outbox) the starting
   * password is optional: one is generated if none is given, and the person
   * receives a link to choose their own. The account is still created exactly
   * as above — active, with the handover gate set — so an invitation that
   * never arrives leaves an account an administrator can still hand over.
   */
  app.post<{ Params: never; Body: Record<string, unknown> }>(
    '/accounts',
    async (request, reply) => {
      await guard.require(request, 'users:manage');

      const body = request.body ?? {};
      const sendInvite = body.sendInvite !== false;
      const fields = requireCreateFields(body, { passwordRequired: !sendInvite });
      const { login, firstName, lastName, email } = fields;
      const password = fields.password || generatePassword();

      // Only what an administrator typed. `generatePassword` guarantees one
      // character from each class at 24 long, so checking it would be checking
      // this file's own arithmetic.
      if (fields.password) {
        const failures = await checkPassword(fields.password, requestSignal(request));
        if (failures.length > 0) {
          throw EpmError.badRequest(`That starting password needs: ${failures.join(', ')}.`);
        }
      }
      const signal = requestSignal(request);

      const created = await openProject.request<OpPrincipal>('/users', {
        method: 'POST',
        body: {
          login,
          firstName,
          lastName,
          email,
          status: 'active',
          password,
          ...(text(body.language) ? { language: text(body.language) } : {}),
          ...(typeof body.admin === 'boolean' ? { admin: body.admin } : {}),
        },
        signal,
      });

      const id = String(created.id);

      // The directory is cached, and a person who does not appear in it cannot
      // be mapped — so it is invalidated before the placement below.
      referenceCache.invalidatePrefix('users');

      // The password was chosen by an administrator, so it is a handover
      // credential and not this person's own. EPM makes them replace it before
      // they can use anything: the upstream API has a `force_password_change`
      // column but accepts and silently ignores the field on both create and
      // update, so the gate has to live where EPM owns the session.
      const { prisma } = await import('../db/prisma.js');
      await prisma.userProfile
        .upsert({
          where: { openProjectId: id },
          create: { openProjectId: id, mustChangePassword: true },
          update: { mustChangePassword: true },
        })
        .catch(() => undefined);

      // The invitation. A failure here is reported as `inviteSent: false`
      // rather than as an error: the account exists, and the administrator
      // can resend from the account page.
      let inviteSent = false;
      if (sendInvite) {
        inviteSent = await sendInvitation({
          account: created,
          createdBy: request.auth?.userId ?? '',
          signal,
        }).catch((error: unknown) => {
          request.log.warn({ err: error, accountId: id }, 'The invitation could not be queued');
          return false;
        });
      }

      // The EPM half. Failing here must not leave the caller believing nothing
      // happened: the account exists either way, so the problem is reported
      // against the placement rather than the creation.
      const placementProblems: string[] = [];

      if (text(body.departmentId) || text(body.teamId)) {
        await setMapping(
          id,
          { departmentId: text(body.departmentId), teamId: text(body.teamId) },
          signal,
        ).catch((error: unknown) => {
          placementProblems.push(error instanceof Error ? error.message : 'The placement failed.');
        });
      }

      if (body.hoursCapacity !== undefined && body.hoursCapacity !== null) {
        await setCapacity(id, { hoursCapacity: body.hoursCapacity }, signal).catch(
          (error: unknown) => {
            placementProblems.push(error instanceof Error ? error.message : 'The capacity failed.');
          },
        );
      }

      reply.code(201);

      const account: EpmAccount & { placementProblems?: string[]; inviteSent: boolean } = {
        ...toEpmAccount(created),
        inviteSent,
      };
      if (placementProblems.length > 0) account.placementProblems = placementProblems;
      return account;
    },
  );

  /**
   * Sends a fresh invitation.
   *
   * Any earlier link stops working the moment this one is made, so a
   * forwarded or leaked first email cannot be used once a second has gone
   * out. `inviteSent` is false when nothing was queued — no address on the
   * account, or the person has turned email off — so the administrator is
   * told rather than left assuming.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/invite', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    const inviteSent = await sendInvitation({
      account,
      createdBy: request.auth?.userId ?? '',
      signal: requestSignal(request),
    });

    return { inviteSent };
  });

  /** Edits a person's details. Not their password, which EPM never touches. */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/accounts/:id',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'users:manage');
      const account = await accountOf(request, id);

      requireAffordance(account, 'updateImmediately', 'You may not edit this person.');

      const body = request.body ?? {};
      const patch: Record<string, unknown> = {};

      for (const field of ['firstName', 'lastName', 'email', 'login', 'language'] as const) {
        if (body[field] !== undefined) {
          const value = text(body[field]);
          if (!value) throw EpmError.badRequest(`${field} cannot be empty.`);
          patch[field] = value;
        }
      }

      if (typeof body.admin === 'boolean') patch.admin = body.admin;

      if (Object.keys(patch).length === 0) throw EpmError.badRequest('Nothing to change.');

      const updated = await openProject.request<OpPrincipal>(`/users/${id}`, {
        method: 'PATCH',
        body: patch,
        signal: requestSignal(request),
      });

      // Name and email are carried in the cached directory — and the address
      // the outbox resolves to, which must not keep going to the old one.
      referenceCache.invalidatePrefix('users');
      forgetRecipient(id);

      return toEpmAccount(updated);
    },
  );

  /**
   * Deactivates an account.
   *
   * Locking, not deleting: it is reversible, it keeps the person's history
   * intact, and it is the same lifecycle every other archivable thing in EPM
   * uses. An invited account offers no `lock` link upstream, and the refusal
   * here says so rather than letting a 406 surface.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/lock', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    requireAffordance(account, 'lock', 'This person cannot be deactivated.');

    const locked = await openProject.request<OpPrincipal>(`/users/${id}/lock`, {
      method: 'POST',
      // A body so the client sends a content type; upstream refuses without one.
      body: {},
      signal: requestSignal(request),
    });

    referenceCache.invalidatePrefix('users');
    return toEpmAccount(locked);
  });

  /** Reactivates a locked account. */
  app.delete<{ Params: { id: string } }>('/accounts/:id/lock', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    requireAffordance(account, 'unlock', 'This person is not deactivated.');

    const unlocked = await openProject.request<OpPrincipal>(`/users/${id}/lock`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    referenceCache.invalidatePrefix('users');
    return toEpmAccount(unlocked);
  });

  /**
   * Revokes a person's access, without removing them.
   *
   * The middle step of offboarding. Deactivating stops a sign-in; this takes
   * away what the account still reaches if it is ever reactivated, or if a
   * browser somewhere is already holding a live session. Three things, each
   * one real:
   *
   * - **Sessions.** EPM's sessions are rows rather than stateless tokens, so
   *   deleting them ends access on that browser's *next request* instead of
   *   whenever a token happens to expire. This is the half that takes effect
   *   immediately, so it goes first.
   * - **Project memberships.** Removed upstream, which is where access to work
   *   actually lives. Locking an account hides it from pickers; it does not
   *   take the person off the projects.
   * - **Instance administrator.** Dropped if set, because an account that
   *   keeps it is one reactivation away from full access again.
   *
   * Deliberately *not* the EPM placement — department, team, capacity. That is
   * the record of where somebody worked, not a key to anything, and deletion
   * removes it already.
   *
   * Nothing here is gated on an upstream affordance, because OpenProject
   * publishes none for membership deletion (see `routes/members.ts`). The gate
   * is `users:manage`, which is admin-only and is already what reading this
   * directory at all requires.
   *
   * A failure to remove one membership does not fail the request: the sessions
   * are already gone, and reporting "nothing happened" when access was in fact
   * withdrawn is the worse lie. What would not come off is named instead.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/revoke', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    // Same reasoning as delete, and for a sharper reason: this ends sessions
    // and strips admin, so an administrator who ran it on themselves could be
    // left unable to undo it.
    if (id === request.auth?.userId) {
      throw EpmError.badRequest('You cannot revoke your own access.');
    }

    const signal = requestSignal(request);
    const problems: string[] = [];

    // 1. Sessions, first — the only part that takes effect at once.
    const { prisma } = await import('../db/prisma.js');
    const sessions = await prisma.session
      .deleteMany({ where: { openProjectId: id } })
      .catch((error: unknown) => {
        problems.push(
          error instanceof Error
            ? `Their sessions could not be ended: ${error.message}`
            : 'Their sessions could not be ended.',
        );
        return { count: 0 };
      });

    // 2. Project memberships.
    //
    // Read unfiltered and narrowed here, which looks wasteful and is not:
    // upstream's `principal` filter only accepts an *active* principal, and
    // answers "Filters User or group filter has invalid values." for a locked
    // one. This runs straight after the account was deactivated, so the
    // filtered form fails every time in the order the flow actually goes in.
    // `mapping/users.ts` walks the same collection on every directory read.
    const memberships = await openProject
      .getAll<OpMembership>('/memberships', { pageSize: 100 }, { signal })
      .catch((error: unknown) => {
        problems.push(
          error instanceof Error
            ? `Their project memberships could not be read: ${error.message}`
            : 'Their project memberships could not be read.',
        );
        return { items: [] as OpMembership[] };
      });

    // The only thing standing between this loop and every membership in the
    // instance, so it is matched on the id from the path rather than on
    // anything the caller sent.
    const theirs = memberships.items.filter(
      (membership) => linkId(membership._links, 'principal') === id,
    );

    let membershipsRemoved = 0;

    for (const membership of theirs) {
      const where = linkTitle(membership._links, 'project') || `membership ${membership.id}`;

      await openProject
        .request<void>(`/memberships/${membership.id}`, { method: 'DELETE', signal })
        .then(() => {
          membershipsRemoved += 1;
        })
        .catch((error: unknown) => {
          problems.push(
            error instanceof Error
              ? `${where}: ${error.message}`
              : `They could not be removed from ${where}.`,
          );
        });
    }

    // 3. Instance administrator.
    let adminRevoked = false;

    if (account.admin) {
      await openProject
        .request<OpPrincipal>(`/users/${id}`, {
          method: 'PATCH',
          body: { admin: false },
          signal,
        })
        .then(() => {
          adminRevoked = true;
        })
        .catch((error: unknown) => {
          problems.push(
            error instanceof Error
              ? `Their administrator rights could not be removed: ${error.message}`
              : 'Their administrator rights could not be removed.',
          );
        });
    }

    // The directory carries the admin flag and the roles derived from
    // memberships, both of which have just changed.
    referenceCache.invalidatePrefix('users');

    const revocation: AccountRevocation = {
      sessionsEnded: sessions.count,
      membershipsRemoved,
      adminRevoked,
    };
    if (problems.length > 0) revocation.problems = problems;

    return revocation;
  });

  /**
   * Deletes a person permanently.
   *
   * Gated on the `delete` affordance, which OpenProject publishes only when the
   * instance allows admins to delete users — off by default. No capability
   * reports this, so the resource is the only source, and offering the action
   * without it would promise something upstream refuses.
   *
   * Upstream returns 202: the work is queued, and the account disappears a
   * moment later rather than immediately. The EPM profile row goes too, since
   * it is keyed on a person who will no longer exist.
   */
  app.delete<{ Params: { id: string } }>('/accounts/:id', async (request, reply) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    // Before the affordance, not after. Deleting yourself is refused because of
    // who is asking, which is true whatever the instance permits — checking the
    // affordance first answered "deletion is switched off here" to an
    // administrator on an instance where it is switched on, and said nothing at
    // all about the part that can never be allowed.
    if (id === request.auth?.userId) {
      throw EpmError.badRequest('You cannot delete your own account.');
    }

    requireAffordance(
      account,
      'delete',
      'Deleting people is switched off for this instance. Turn on "Users deletable by admins" ' +
        'in Administration → Users and permissions → User settings to allow it, or lock ' +
        'the account instead to revoke access without removing the record.',
    );

    await openProject.request<void>(`/users/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    const { prisma } = await import('../db/prisma.js');
    await prisma.userProfile.deleteMany({ where: { openProjectId: id } }).catch(() => undefined);

    // Upstream queues the deletion and answers 202, so the account is still
    // readable for a moment afterwards. Invalidating the cached directory
    // immediately was worse than not invalidating at all: the next read
    // refilled it with the person who was about to disappear, and they stayed
    // on the Employees page for the whole five-minute lifetime of that cache.
    //
    // So wait for them to be gone, briefly and with a bound, and clear the
    // cache after. In practice this takes about a second.
    const deadline = Date.now() + 8_000;
    let gone = false;

    while (!gone && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const still = await openProject
        .request<OpPrincipal>(`/users/${id}`, { signal: requestSignal(request) })
        .catch(() => null);
      gone = still === null;
    }

    referenceCache.invalidatePrefix('users');

    // 202 when it has not finished: the work was accepted and is still running,
    // which is the truth rather than a 204 claiming it is done.
    reply.code(gone ? 204 : 202);
  });
};
