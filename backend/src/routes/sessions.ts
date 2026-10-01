import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import type { EpmBrowserSession } from '../types/epm.js';

/**
 * The signed-in person's own sessions.
 *
 * EPM's sessions are rows, not stateless tokens, which is what makes this
 * possible at all: there is a definitive list of where somebody is signed in,
 * and revoking one takes effect on that browser's next request rather than
 * whenever a token happens to expire. OpenProject has nothing equivalent to
 * offer over its API, so this is EPM's own — and is the reason the Security
 * page can do something rather than only describe policy.
 *
 * Always the caller's own. The id comes from the session that made the request
 * and every query filters on it, so there is no way to list or end anybody
 * else's — a revoke with someone else's id matches zero rows rather than theirs.
 *
 * Nothing here ever includes a token. The rows hold OAuth credentials encrypted
 * at rest; what is published is when the session began, when it was last used,
 * when it expires, and what the browser claimed to be. That is enough for a
 * person to recognise their own devices and no use to anyone who intercepts it.
 */

/**
 * A readable name for a browser, from what it said about itself.
 *
 * Deliberately shallow. Full user-agent parsing is a library and a maintenance
 * commitment, and the question here is only "is this one mine?" — for which
 * "Chrome on Windows" is as useful as a version-accurate answer. The raw string
 * travels alongside for anyone who wants certainty.
 *
 * Order matters in both lists: Edge and Opera both claim to be Chrome, Chrome
 * claims to be Safari, and iPadOS claims to be a Mac, so the more specific
 * pattern has to be tested first.
 */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser =
    [
      ['Edg/', 'Edge'],
      ['OPR/', 'Opera'],
      ['Firefox/', 'Firefox'],
      ['Chrome/', 'Chrome'],
      ['Safari/', 'Safari'],
    ].find(([token]) => userAgent.includes(token!))?.[1] ?? 'Browser';

  const platform =
    [
      ['iPhone', 'iPhone'],
      ['iPad', 'iPad'],
      ['Android', 'Android'],
      ['Mac OS X', 'macOS'],
      ['Windows', 'Windows'],
      ['Linux', 'Linux'],
    ].find(([token]) => userAgent.includes(token!))?.[1] ?? 'an unknown platform';

  return `${browser} on ${platform}`;
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /** Every live session for the caller, most recently used first. */
  app.get('/me/sessions', async (request): Promise<EpmBrowserSession[]> => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized();

    const rows = await prisma.session.findMany({
      // Expired rows are removed lazily, when someone tries to use one, so the
      // table can hold sessions that are already dead. They are excluded here
      // rather than listed as revocable: offering to end a session that has
      // already ended is a control that does nothing.
      where: { openProjectId: auth.userId, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        userAgent: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      current: row.id === auth.sessionId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      device: describeDevice(row.userAgent),
      userAgent: row.userAgent ?? undefined,
    }));
  });

  /**
   * Ends one other session.
   *
   * The current one is refused rather than allowed through as a sign-out: the
   * browser would keep a cookie pointing at a row that no longer exists, and
   * every later request would 401 with no explanation. Signing out is
   * `/auth/logout`, which also clears the cookie.
   */
  app.delete<{ Params: { id: string } }>('/me/sessions/:id', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized();

    const { id } = request.params;
    if (id === auth.sessionId) {
      throw EpmError.badRequest('That is this browser. Use sign out to end this session.');
    }

    // Ownership is the query, not a check followed by trust: a session id
    // belonging to somebody else matches nothing.
    const { count } = await prisma.session.deleteMany({
      where: { id, openProjectId: auth.userId },
    });

    if (count === 0) throw EpmError.notFound('That session');

    reply.code(204);
  });

  /**
   * Ends every session except this one.
   *
   * The one button that matters after a lost laptop, so it is a single action
   * rather than a list to work through. This browser is deliberately kept — a
   * person locking everyone else out should not have to sign in again to
   * confirm it worked.
   */
  app.post('/me/sessions/revoke-others', async (request) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized();

    const { count } = await prisma.session.deleteMany({
      where: { openProjectId: auth.userId, id: { not: auth.sessionId } },
    });

    request.log.info({ count }, 'Other sessions revoked at the user request');
    return { revoked: count };
  });
};
