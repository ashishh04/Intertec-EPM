import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import { env, isProduction } from './config/env.js';
import { residencyWarning } from './assistant/bedrock.js';
import { httpDuration, httpRequests, statusClass } from './lib/metrics.js';
import { registerMetrics } from './routes/metrics.js';
import { createAnalyticsSnapshotScheduler } from './scheduler/analytics-snapshot.js';
import { createAnalyticsRefreshScheduler } from './scheduler/analytics-refresh.js';
import { createReportScheduler } from './scheduler/report-scheduler.js';
import { publishCatalogue } from './domain/measures-store.js';
import { markModelStale } from './domain/analytics-model.js';
import { createDueReminderScheduler } from './scheduler/due-reminders.js';
import { createTimesheetReminders } from './scheduler/timesheet-reminders.js';
import { createHealthSweep } from './scheduler/health-sweep.js';
import { createBurndownSampler } from './scheduler/burndown-sampler.js';
import { createScheduleCheck } from './scheduler/schedule-check.js';
import { createCalculatedCheck } from './scheduler/calculated-check.js';
import { createRecurrenceScheduler } from './scheduler/recurrence.js';
import { createApprovalSweep } from './scheduler/approval-sweep.js';
import { createEscalationSweep } from './scheduler/escalation-sweep.js';
import { createRuleWorker } from './scheduler/rule-worker.js';
import { createEmailWorker } from './scheduler/email-worker.js';
import { describeEmailProvider, useEmailLogger } from './email/index.js';
import { useAppLogger } from './lib/log.js';
import { disconnectPrisma, prismaReady } from './db/prisma.js';
import { EpmError } from './lib/errors.js';
import { issueMessage, requestConventions, requestLanguage, runWithLanguage, t } from './lib/i18n.js';
import { forgetPermissions } from './auth/capabilities.js';
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
    // The frontend serializes array filters comma-joined (`status=todo,done`),
    // not as repeated keys, so the default parser is all we need.
    ajv: { customOptions: { coerceTypes: 'array' } },
  });

  await app.register(helmet, {
    // Nothing this service returns is a page: JSON, downloads, avatars and the
    // assistant's event stream. So the policy allows nothing at all, and a
    // response opened directly in a tab — an uploaded SVG, say — can neither
    // run nor load anything. The app's own pages get their policy from Caddy,
    // which does not apply it to /api (BRL-01, BR-608).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        sandbox: [],
      },
    },
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

  // The request's language, calendar and digits, for code that writes for a
  // reader without being handed the request (`contextLanguage()`,
  // `contextConventions()`).
  app.addHook('onRequest', (request, _reply, done) => {
    runWithLanguage(requestLanguage(request), () => done(), requestConventions(request));
  });

  // Every message leaves in the language the request asked for (BR-605); the
  // log keeps the English, which is what an operator searches for.
  app.setErrorHandler((error, request, reply) => {
    const language = requestLanguage(request);

    if (error instanceof EpmError) {
      // Upstream detail is diagnostic, not something the browser should see.
      if (error.status >= 500) {
        request.log.error({ err: error, upstream: error.upstream }, error.message);
      } else {
        request.log.warn({ code: error.code, status: error.status }, error.message);
      }
      return reply.status(error.status).send(error.toBody(language));
    }

    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'Request validation failed');
      return reply.status(400).send({
        message: t(language, 'The request was not valid.'),
        code: 'BAD_REQUEST',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issueMessage(language, issue),
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
        message: t(language, message ?? 'The request was not valid.'),
        code,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      message: t(language, 'Something went wrong on our end.'),
      code: 'INTERNAL',
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      message: t(requestLanguage(request), 'No route for {method} {url}.', {
        method: request.method,
        url: request.url,
      }),
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

  // Scrape target for monitoring (NFR12); off unless EPM_METRICS_TOKEN is set.
  registerMetrics(app);

  // Request figures for /metrics, labelled by the route's pattern
  // (`/api/projects/:id`, not every id) so the set of series stays bounded.
  // The same label goes on the request's log lines, with the person once the
  // session is known (auth/hook.ts), so a slow or failing call can be traced.
  app.addHook('onRequest', async (request) => {
    (request.log as { setBindings?: (bindings: Record<string, unknown>) => void }).setBindings?.({
      route: request.routeOptions.url ?? 'unmatched',
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpRequests.inc({ method: request.method, route, status: statusClass(reply.statusCode) });
    httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
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
  /** Writes that cannot change anything the analytics model holds. */
  const NOT_MODELLED = ['/analytics/', '/auth/', '/sessions', '/notifications', '/preferences', '/assistant'];

  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (reply.statusCode >= 400) return;
    aggregateCache.clear();

    // The caller's permissions go with them. Creating a project grants the
    // creator rights on it, and those are cached for a minute — long enough
    // that the new project's buttons would stay disabled with no explanation.
    // Only this caller's entry: a write by one person does not change anybody
    // else's permissions except through membership, which the TTL covers.
    if (request.auth) forgetPermissions(request.auth.userId);

    // And the analytics model is due an incremental refresh. Work changes
    // reach it through the rule queue already; this covers what does not pass
    // through there — departments, teams, people, portfolios, plans, rates,
    // time — so the dashboards catch up within a tick, not an interval.
    if (!NOT_MODELLED.some((prefix) => request.url.startsWith(`${env.API_PREFIX}${prefix}`))) markModelStale();
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

  // Where the assistant would send what it reads, said once at startup
  // (NFR09): it is off when its configuration breaks the allowed regions, and
  // a production deployment with no allow-list at all is worth a line too.
  const residency = residencyWarning();
  if (residency) app.log.warn(residency);
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

  // Outstanding timesheet reminders (BR-306). Started always, inert until the
  // time and expense settings switch reminders on — an administrator's choice.
  const timesheetReminders = createTimesheetReminders({ log: app.log });
  timesheetReminders.start();

  // The health sweep. On by default, unlike the schedulers above: it is what
  // keeps stored health true when changes happen where EPM cannot see them.
  const healthSweep = createHealthSweep({ log: app.log });
  if (env.EPM_HEALTH_SWEEP_ENABLED) {
    healthSweep.start();
  } else {
    app.log.info('Health sweep disabled; health is recalculated on change only');
  }

  // The burndown sampler. On by default: without it every burndown chart is
  // empty.
  const burndownSampler = createBurndownSampler({ log: app.log });
  if (env.EPM_BURNDOWN_SAMPLER_ENABLED) {
    burndownSampler.start();
  } else {
    app.log.info('Burndown sampler disabled; burndown charts show today only');
  }

  // SLA escalations and delegation upkeep for approvals, on the same terms.
  const approvalSweep = createApprovalSweep({ log: app.log });
  if (env.EPM_APPROVAL_SWEEP_ENABLED) {
    approvalSweep.start();
  } else {
    app.log.info('Approval sweep disabled; SLA breaches will not be escalated');
  }

  // Rules (BR-216, BR-217) act on queued events; escalation policies (BR-218)
  // are evaluated on a schedule. Both on unless switched off.
  const ruleWorker = createRuleWorker({ log: app.log });
  if (env.EPM_RULES_ENABLED) {
    ruleWorker.start();
  } else {
    app.log.info('Rule worker disabled; events are queued but no rule acts on them');
  }
  const escalationSweep = createEscalationSweep({ log: app.log });
  if (env.EPM_ESCALATION_SWEEP_ENABLED) {
    escalationSweep.start();
  } else {
    app.log.info('Escalation sweep disabled; nothing untouched or overdue will be escalated');
  }

  // The analytics model (BR-402) and the semantic layer's catalogue (BR-404).
  // On unless switched off: every dashboard reads the model.
  const analyticsRefresh = createAnalyticsRefreshScheduler({ log: app.log });
  if (env.EPM_ANALYTICS_MODEL_ENABLED) {
    analyticsRefresh.start();
    void publishCatalogue().catch((error: unknown) => {
      app.log.warn({ err: error }, 'The measure catalogue could not be published to the analytics schema');
    });
  } else {
    app.log.info('Analytics model refresh disabled; dashboards show the model as last loaded');
  }

  // Scheduled reports (BR-207), on unless switched off.
  const reportScheduler = createReportScheduler({ log: app.log });
  if (env.EPM_REPORT_SCHEDULER_ENABLED) {
    reportScheduler.start();
  } else {
    app.log.info('Report scheduler disabled; scheduled reports go out only when run by hand');
  }

  // The critical path check (BR-104): float recalculated when OpenProject's
  // network moves under EPM. On unless switched off.
  const scheduleCheck = createScheduleCheck({ log: app.log });
  if (env.EPM_SCHEDULE_ENABLED) {
    scheduleCheck.start();
  } else {
    app.log.info('Critical path disabled; float is neither computed nor shown');
  }

  // The calculated field check (BR-408): values recalculated when what their
  // formulas read moves under EPM, or the day turns. On unless switched off.
  const calculatedCheck = createCalculatedCheck({ log: app.log });
  if (env.EPM_CALCULATED_ENABLED) {
    calculatedCheck.start();
  } else {
    app.log.info('Calculated fields disabled; their values are not recalculated');
  }

  // Recurring tasks (BR-106): each series' tasks made at their lead time, as
  // the automation account. On unless switched off.
  const recurrence = createRecurrenceScheduler({ log: app.log });
  if (env.EPM_RECURRENCE_ENABLED) {
    recurrence.start();
  } else {
    app.log.info('Recurring task generation disabled; tasks are made only when asked for');
  }

  app.addHook('onClose', async () => {
    recurrence.stop();
    scheduleCheck.stop();
    calculatedCheck.stop();
    reportScheduler.stop();
    analyticsRefresh.stop();
    ruleWorker.stop();
    escalationSweep.stop();
    approvalSweep.stop();
    healthSweep.stop();
    burndownSampler.stop();
    dueReminders.stop();
    timesheetReminders.stop();
    snapshots.stop();
    emailWorker.stop();
    await disconnectPrisma();
  });

  return app;
}
