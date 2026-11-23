import type { FastifyPluginAsync } from 'fastify';

import { openSessions } from '../auth/oauth.js';
import { EpmError } from '../lib/errors.js';
import { addListener, announce, areaOfUpstream, dropListener, everyListener, write } from '../lib/live.js';
import { onOpenProjectWrite } from '../openproject/client.js';

/**
 * The live update stream (lib/live.ts): `GET /events`, Server-Sent Events.
 *
 * One per open page. A comment every 25 seconds keeps proxies from closing it
 * as idle, and is when its session is looked at: a session that has ended — no
 * activity for too long, past the longest it may last, signed out — closes its
 * streams. The browser's reads of this stream are not activity (auth/hook.ts),
 * so an open page does not keep an idle session alive.
 */

const HEARTBEAT_MS = 25_000;

let heartbeat: NodeJS.Timeout | undefined;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    void beat();
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

async function beat(): Promise<void> {
  const listeners = [...everyListener().entries()];
  if (listeners.length === 0) return;
  const open = await openSessions([...new Set(listeners.map(([, listener]) => listener.sessionId))]);
  for (const [id, listener] of listeners) {
    if (!open.has(listener.sessionId) || !write(listener.stream, ': still here\n\n')) dropListener(id);
  }
}

// Every write to OpenProject, whoever makes it — a person's request, the rules,
// an import running behind — says which area it changed.
onOpenProjectWrite((_method, path) => {
  const area = areaOfUpstream(path);
  if (area) announce(area);
});

export const liveRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized('You are not signed in.');

    // Written by hand from here: the reply stays open, and nothing of Fastify's
    // own sending applies — so the headers already set (CORS) are carried over.
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Nothing between here and the browser may hold it back or compress it.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Reconnect five seconds after the connection drops, then say hello.
    stream.write('retry: 5000\n\n: listening\n\n');

    const remove = addListener({ userId: auth.userId, sessionId: auth.sessionId, stream });
    startHeartbeat();
    // The response's close, which is the browser going: the request's own
    // fires as soon as it has been read (see lib/request-signal.ts).
    stream.on('close', remove);
  });
};
