import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { hashInviteToken } from '../email/invites.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import { checkPassword } from '../domain/password-policy.js';
import type { OpPrincipal } from '../openproject/types.js';
import type { InviteInfo } from '../types/epm.js';

/**
 * Invitations.
 *
 * Both routes are public — the person holding the link has no account they
 * can sign in to yet, which is the whole point. What they can learn and do is
 * bounded by the token: a first name and an address to confirm they are on
 * the right page, and one chance to set a password. The user id behind the
 * token is never returned; the token is the only handle the visitor gets.
 *
 * The password is written upstream with the service key, because there is no
 * session to write it with. That is the one place in EPM an unauthenticated
 * request leads to an administrative write, and it is gated on possessing an
 * unexpired, unused token that only the invitee's inbox ever saw.
 */

const ORGANISATION = 'Intertec Systems';

/** What a token looks like: base64url of 32 bytes. Anything else is not ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const acceptSchema = z.object({
  password: z.string().min(12, 'Choose a password of at least 12 characters.'),
});

async function inviteByToken(token: string) {
  if (!TOKEN_SHAPE.test(token)) throw EpmError.notFound('That invitation');

  const invite = await prisma.inviteToken.findUnique({ where: { tokenHash: hashInviteToken(token) } });
  if (!invite) throw EpmError.notFound('That invitation');

  return invite;
}

function stateOf(invite: { usedAt: Date | null; expiresAt: Date }): InviteInfo['state'] {
  if (invite.usedAt) return 'used';
  if (invite.expiresAt.getTime() < Date.now()) return 'expired';
  return 'valid';
}

export const invitesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { token: string } }>('/invites/:token', async (request): Promise<InviteInfo> => {
    const invite = await inviteByToken(request.params.token);

    // The name is read live rather than stored with the token, so a
    // correction made after the invitation went out shows on the page.
    const account = await openProject
      .request<OpPrincipal>(`/users/${invite.openProjectId}`, { signal: requestSignal(request) })
      .catch(() => null);

    return {
      firstName: account?.firstName?.trim() || account?.name || '',
      email: invite.email,
      organisation: ORGANISATION,
      expiresAt: invite.expiresAt.toISOString(),
      state: stateOf(invite),
    };
  });

  app.post<{ Params: { token: string }; Body: unknown }>(
    '/invites/:token/accept',
    {
      // Ten a minute from one address: a token is 256 bits and cannot be
      // guessed, but the password rules upstream are a signal worth not
      // handing out at the global rate.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { password } = acceptSchema.parse(request.body ?? {});
      const invite = await inviteByToken(request.params.token);

      const state = stateOf(invite);
      if (state === 'used') throw EpmError.gone('This invitation has already been used.');
      if (state === 'expired') {
        throw EpmError.gone('This invitation has expired. Ask your administrator to send a new one.');
      }

      // The instance's own rules, read from it rather than restated, and
      // applied before the call so the same policy holds on every path a
      // password can be set — this one is reachable without a session.
      const failures = await checkPassword(password, requestSignal(request));
      if (failures.length > 0) {
        throw EpmError.badRequest(`That password needs: ${failures.join(', ')}.`);
      }

      const account = await openProject.request<OpPrincipal>(`/users/${invite.openProjectId}`, {
        method: 'PATCH',
        body: { password },
        signal: requestSignal(request),
      });

      // The handover gate exists for a password an administrator chose. This
      // one the person chose themselves.
      await prisma.userProfile
        .updateMany({ where: { openProjectId: invite.openProjectId }, data: { mustChangePassword: false } })
        .catch(() => undefined);

      // Marked used after the password is set, not before: a token burnt by a
      // failed upstream write would leave the person with no way in.
      await prisma.inviteToken.update({ where: { id: invite.id }, data: { usedAt: new Date() } });

      return { login: account.login ?? '' };
    },
  );

  /**
   * Recent outbox rows, for an administrator working out why an email did or
   * did not go. Payloads are omitted: an invitation's carries its link.
   */
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/admin/email/outbox',
    async (request) => {
      await guard.require(request, 'users:manage');

      const status = request.query.status?.trim();
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);

      const rows = await prisma.emailOutbox.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          recipientId: true,
          toEmail: true,
          template: true,
          subject: true,
          status: true,
          channel: true,
          attempts: true,
          lastError: true,
          providerId: true,
          dedupeKey: true,
          scheduledFor: true,
          sentAt: true,
          createdAt: true,
        },
      });

      return rows.map((row) => ({
        ...row,
        scheduledFor: row.scheduledFor.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );
};
