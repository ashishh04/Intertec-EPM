import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { env } from '../config/env.js';
import { prisma, prismaReady } from '../db/prisma.js';
import { renderProcessMetrics } from '../lib/metrics.js';
import { openProjectReady } from '../openproject/client.js';

/**
 * `/metrics` (NFR12): health, latency and error figures for the client's
 * monitoring to scrape, in the Prometheus text format.
 *
 * Off unless EPM_METRICS_TOKEN is set, and then answered only to a request
 * carrying it as a bearer token. Outside the API prefix, like /health and
 * /ready, and never routed by Caddy — the scraper reaches each backend on the
 * internal network — so the token is a second lock, not the only one.
 *
 * Two kinds of figure. This server's own (requests, latency, calls to
 * OpenProject, memory, event loop) from `lib/metrics.ts`; and the shared
 * state only the database knows — the outbox, the rule queue, the last model
 * refresh, failed report runs, which jobs hold a lease — read at scrape time,
 * so every server reports the same truth.
 */

function authorised(header: string | undefined): boolean {
  const expected = env.EPM_METRICS_TOKEN;
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

const gauge = (name: string, help: string, rows: [Record<string, string>, number][]): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} gauge`,
  ...rows.map(([labels, value]) => {
    const inner = Object.entries(labels)
      .map(([label, text]) => `${label}=${JSON.stringify(text)}`)
      .join(',');
    return `${name}${inner ? `{${inner}}` : ''} ${value}`;
  }),
];

const ageSeconds = (at: Date | null | undefined) => (at ? Math.max(0, Math.round((Date.now() - at.getTime()) / 1000)) : -1);

async function sharedState(): Promise<string[]> {
  const [database, upstream] = await Promise.all([prismaReady(), openProjectReady()]);
  const lines = gauge('epm_dependency_up', 'Whether this server can use a dependency right now (the /ready checks).', [
    [{ dependency: 'database' }, database.ok ? 1 : 0],
    [{ dependency: 'openproject' }, upstream.ok ? 1 : 0],
  ]);
  if (!database.ok) return lines;

  const [outbox, oldestQueued, pendingRules, oldestRule, refreshes, failedReports, leases] = await Promise.all([
    prisma.emailOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.emailOutbox.findFirst({
      where: { status: 'queued', channel: 'immediate', scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      select: { scheduledFor: true },
    }),
    prisma.ruleEvent.count({ where: { processedAt: null } }),
    prisma.ruleEvent.findFirst({ where: { processedAt: null }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
    prisma
      .$queryRawUnsafe<{ kind: string; status: string; started_at: Date }[]>(
        `SELECT DISTINCT ON (kind) kind, status, started_at FROM analytics.refresh_run
          WHERE status <> 'running' ORDER BY kind, started_at DESC`,
      )
      .catch(() => [] as { kind: string; status: string; started_at: Date }[]),
    prisma.reportRun.count({ where: { status: 'failed', startedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.jobLease.findMany({ where: { expiresAt: { gt: new Date() } }, select: { name: true } }),
  ]);

  return [
    ...lines,
    ...gauge(
      'epm_email_outbox_rows',
      'Emails in the outbox by state; failed ones gave up after every retry.',
      ['queued', 'sending', 'failed'].map((status) => [
        { status },
        outbox.find((row) => row.status === status)?._count._all ?? 0,
      ]),
    ),
    ...gauge('epm_email_oldest_due_seconds', 'Age of the oldest email that is due and not yet sent (-1: none).', [
      [{}, ageSeconds(oldestQueued?.scheduledFor)],
    ]),
    ...gauge('epm_rule_events_pending', 'Changes waiting for the rule worker.', [[{}, pendingRules]]),
    ...gauge('epm_rule_event_oldest_seconds', 'Age of the oldest change still waiting (-1: none).', [
      [{}, ageSeconds(oldestRule?.receivedAt)],
    ]),
    ...gauge(
      'epm_analytics_refresh_last_seconds',
      'Seconds since the analytics model last finished a refresh of this kind.',
      refreshes.map((run) => [{ kind: run.kind }, ageSeconds(run.started_at)]),
    ),
    ...gauge(
      'epm_analytics_refresh_last_ok',
      'Whether the last finished refresh of this kind succeeded.',
      refreshes.map((run) => [{ kind: run.kind }, run.status === 'succeeded' ? 1 : 0]),
    ),
    ...gauge('epm_report_runs_failed_24h', 'Scheduled report runs that failed in the last day.', [[{}, failedReports]]),
    ...gauge(
      'epm_job_lease_held',
      'Scheduled jobs running somewhere right now (a held lease).',
      leases.map((lease) => [{ job: lease.name }, 1]),
    ),
  ];
}

export function registerMetrics(app: FastifyInstance): void {
  app.get('/metrics', async (request, reply) => {
    if (!env.EPM_METRICS_TOKEN) {
      return reply.code(404).send({ message: 'Metrics are switched off: set EPM_METRICS_TOKEN.', code: 'NOT_FOUND' });
    }
    if (!authorised(request.headers.authorization)) {
      return reply.code(401).send({ message: 'A valid metrics token is required.', code: 'UNAUTHORIZED' });
    }
    const body = [...renderProcessMetrics(), ...(await sharedState())].join('\n') + '\n';
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });
}
