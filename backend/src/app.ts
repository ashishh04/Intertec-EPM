import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import { env, isProduction } from './config/env.js';
import { disconnectPrisma } from './db/prisma.js';
import { EpmError } from './lib/errors.js';
import { registerAuth } from './auth/hook.js';
import { registerRequestSignal } from './lib/request-signal.js';
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
      // The Authorization header carries the OpenProject key on the way out and
      // the session cookie on the way in. Neither belongs in a log line.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
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
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
    max: 600,
    timeWindow: '1 minute',
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
  app.get('/health', async () => ({ status: 'ok' }));

  registerRequestSignal(app);
  registerAuth(app, env.API_PREFIX);

  await app.register(registerRoutes, { prefix: env.API_PREFIX });

  // Release the pool on shutdown; `app.close()` alone leaves it open.
  app.addHook('onClose', async () => {
    await disconnectPrisma();
  });

  return app;
}
