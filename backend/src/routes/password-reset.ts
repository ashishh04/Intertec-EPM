import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { completePasswordReset, requestPasswordReset, resetLinkInfo, RESET_TTL_MINUTES } from '../domain/password-reset.js';
import { emailDelivery } from '../email/index.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';

/**
 * Forgotten passwords (Module 1).
 *
 * All three routes are public: the person cannot sign in, which is the point.
 * Asking for a link answers the same way, at once, whether or not the login
 * or email matches anyone, and the work happens after the answer, so neither
 * the reply nor how long it took tells anyone which accounts exist. What a
 * link can do is bounded by its token, as an invitation's is: one password,
 * within the hour.
 */

const requestSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username or email address.').max(254),
});

const completeSchema = z.object({
  password: z.string().min(1, 'Choose a password.').max(256),
});

export const passwordResetRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: unknown }>(
    '/password-reset',
    // Five per quarter hour from one address, on top of three links an hour
    // per account: enough to retry, too few to flood anyone's inbox.
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { identifier } = requestSchema.parse(request.body ?? {});

      // Said plainly rather than pretending: with nothing that delivers mail,
      // no link could ever arrive. True of the server, not of any account.
      if (emailDelivery().kind === 'none') {
        throw EpmError.unavailable('Password reset by email is not set up on this server. Contact IT support to regain access.');
      }

      void requestPasswordReset(identifier, request.ip ?? null).then(
        (outcome) => request.log.info({ outcome }, 'Password reset requested'),
        (error: unknown) => request.log.error({ err: error }, 'Password reset request failed'),
      );

      reply.code(202);
      return { accepted: true, validMinutes: RESET_TTL_MINUTES };
    },
  );

  app.get<{ Params: { token: string } }>('/password-reset/:token', async (request) =>
    resetLinkInfo(request.params.token, requestSignal(request)),
  );

  app.post<{ Params: { token: string }; Body: unknown }>(
    '/password-reset/:token',
    // As for invitations: a token cannot be guessed, but the password rules
    // are a signal worth not handing out at the global rate.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { password } = completeSchema.parse(request.body ?? {});
      return completePasswordReset(request.params.token, password);
    },
  );
};
