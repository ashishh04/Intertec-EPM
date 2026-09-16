import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import { env, isProduction } from './config/env.js';
import { createAnalyticsSnapshotScheduler } from './scheduler/analytics-snapshot.js';
import { createDueReminderScheduler } from './scheduler/due-reminders.js';
import { createEmailWorker } from './scheduler/email-worker.js';
import { describeEmailProvider, useEmailLogger } from './email/index.js';
import { useAppLogger } from './lib/log.js';
import { disconnectPrisma, prismaReady } from './db/prisma.js';
import { EpmError } from './lib/errors.js';
import { registerAuth } from './auth/hook.js';
import { SESSION_COOKIE } from './auth/oauth.js';
import { registerRequestSignal } from './lib/request-signal.js';
import { aggregateCache } from './lib/cache.js';
import { openProjectReady } from './openproject/client.js';
import { registerRoutes } from './routes/index.js';

/**
 * Fastify application.
 *
 * Two things here are load-bearing for the frontend and must not change shape:
 * the error envelope (`{ message, code, details }`) and credentialed CORS
 * against explicit origins — the browser rejects `*` when the client sends
 * `credentials: 'include'`, which the EPM ApiClient always does.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // The Authorization header carries the upstream key on the way out and
      // the session cookie on the way in. Neither belongs in a log line, and
      // nor does a starting password on the way to creating an account —
      // Fastify does not log bodies by default, but this survives anyone
      // deciding it should.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'body.password',
          'password',
        ],
        censor: '[redacted]',
      },
      ...(isProduction ? {} : { transport: { target: 'pino-pretty' } }),
    },
    trustProxy: isProduction,
    disableRequestLogging: false,
    // The frontend serializes array filters comma-joined (`status=todo,done`),
    // not as repeated keys, so the default parser is all we need.
    ajv: { customOptions: { coerceTypes: 'array' } },
  });

  await app.register(helmet, {
    // This service only ever returns JSON to a separate origin; CSP here would
    // describe a document it never serves.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
    },
  });

  // Uploads arrive as multipart. The per-file ceiling is enforced per request
  // from the instance's own configuration; this is a backstop against a body
  // that never ends.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 },
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    /*
     * Key on the session, not the IP.
     *
     * The default keys on `request.ip`, which is wrong for an internal tool:
     * a workforce behind one corporate egress shares a single bucket, so the
     * limit meant to stop one abusive client throttles everybody at once. One
     * dashboard load is 14 requests, so a shared 600/min ceiling is about 43
     * page loads per minute for the whole company.
     *
     * Signed-in traffic is therefore limited per person. Unauthenticated
     * traffic — the login endpoint above all — still keys on IP, which is
     * what you want for credential stuffing.
     */
    keyGenerator: (request) => request.cookies?.[SESSION_COOKIE] ?? request.ip,
    // `statusCode` has to be on the returned object: the plugin throws it as
    // the error, and without it the handler below sees no status and reports a
    // 500 — which reads as a server fault rather than a deliberate refusal.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      message: `Too many requests. Please retry in ${Math.ceil(context.ttl / 1000)} seconds.`,
      code: 'RATE_LIMITED',
    }),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EpmError) {
      // Upstream detail is diagnostic, not something the browser should see.
      if (error.status >= 500) {
        request.log.error({ err: error, upstream: error.upstream }, error.message);
      } else {
        request.log.warn({ code: error.code, status: error.status }, error.message);
      }
      return reply.status(error.status).send(error.toBody());
    }

    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'Request validation failed');
      return reply.status(400).send({
        message: 'The request was not valid.',
        code: 'BAD_REQUEST',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    // Fastify's own errors (bad JSON body, failed schema validation, rate limit)
    // arrive with a statusCode already set.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      // Keep the plugin's own code when it supplies one, so a throttled caller
      // is told they were throttled rather than that their request was invalid.
      // Plugins may throw a plain object rather than an Error, so read the
      // message off the value instead of gating on `instanceof`.
      const { code = 'BAD_REQUEST', message } = error as { code?: string; message?: string };
      return reply.status(statusCode).send({
        message: message ?? 'The request was not valid.',
        code,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      message: 'Something went wrong on our end.',
      code: 'INTERNAL',
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      message: `No route for ${request.method} ${request.url}.`,
      code: 'NOT_FOUND',
    }),
  );

  // Liveness, outside the API prefix so orchestration does not need to know it.
  // Answers as long as the process is up; deliberately checks nothing, so a
  // restart loop is never triggered by a dependency being briefly unwell.
  app.get('/health', async () => ({ status: 'ok' }));

  /*
   * Readiness: can this instance actually serve a request?
   *
   * `/health` returning ok while the database is unreachable or OpenProject is
   * still booting is the failure mode this exists for — the process is alive
   * and every request 500s, and nothing outside notices. Both dependencies are
   * checked because the service is useful without neither.
   *
   * 503 when either is down, so a load balancer takes the instance out rather
   * than sending traffic to something that cannot answer. The body names which
   * one, because "not ready" without that is a page of guessing.
   */
  app.get('/ready', async (_request, reply) => {
    const [database, upstream] = await Promise.all([
      prismaReady(),
      openProjectReady(),
    ]);

    const ready = database.ok && upstream.ok;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'unavailable',
      checks: { database, openProject: upstream },
    });
  });

  registerRequestSignal(app);
  registerAuth(app, env.API_PREFIX);

  /*
   * Any successful write drops the derived caches.
   *
   * `aggregateCache` holds counts, lists and rollups computed from OpenProject
   * — the project list, sprints, dashboard KPIs, activity, trends. All of them
   * can be changed by almost any mutation, and a 20s stale KPI after you
   * create something reads as a bug rather than as caching. Clearing the whole
   * cache is blunt, but each entry costs one recompute to restore and this
   * cannot miss a route the way per-handler invalidation does.
   *
   * `referenceCache` is deliberately untouched: statuses, types and principals
   * change through their own endpoints, which invalidate their own keys.
   */
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (reply.statusCode >= 400) return;
    aggregateCache.clear();
  });

  await app.register(registerRoutes, { prefix: env.API_PREFIX });

  // Periodic analytics capture. Off unless asked for: a scheduler that started
  // itself would write to the metric table during every test run and every
  // `npm run dev`.
  const snapshots = createAnalyticsSnapshotScheduler({ log: app.log });
  if (env.EPM_ANALYTICS_SNAPSHOT_ENABLED) {
    snapshots.start();
  } else {
    app.log.info('Analytics snapshot scheduler disabled');
  }

  // The outbox worker, on the same terms. Enqueueing is always on — a request
  // that writes a row costs nothing and loses nothing — but sending is a
  // process that mails people and has to be asked to. The email module logs
  // through the app's logger from here on, wherever it is called from.
  useEmailLogger(app.log);
  useAppLogger(app.log);
  const emailWorker = createEmailWorker({ log: app.log });
  if (env.EPM_EMAIL_WORKER_ENABLED) {
    emailWorker.start();
  } else {
    app.log.info({ provider: describeEmailProvider() }, 'Email worker disabled; email is queued but not sent');
  }

  // Release the pool on shutdown; `app.close()` alone leaves it open. The
  // timers go with it, so a closed app leaves nothing running.
  // The daily deadline reminder. Same reasoning as the snapshot scheduler: a
  // timer that emails people must be asked for, never assumed.
  const dueReminders = createDueReminderScheduler({ log: app.log });
  if (env.EPM_DUE_REMINDER_ENABLED) {
    dueReminders.start();
  } else {
    app.log.info('Due reminder scheduler disabled');
  }

  app.addHook('onClose', async () => {
    dueReminders.stop();
    snapshots.stop();
    emailWorker.stop();
    await disconnectPrisma();
  });

  return app;
}
