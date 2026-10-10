import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { captureWorkPackages } from '../domain/analytics-history.js';
import {
  changedSinceLastRefresh,
  clearModelStale,
  refreshModel,
  type RefreshKind,
  type RefreshTrigger,
} from '../domain/analytics-model.js';
import { withLease } from '../domain/job-lease.js';
import { materialiseEarnedValue, materialiseMeasures, materialisedToday } from '../domain/measures-store.js';

/**
 * Keeps the analytics model current (BR-402) and its history checkable (BR-403).
 *
 * A short tick decides what is due, most important first:
 *
 *   the nightly full refresh   at the configured hour, once a day: everything
 *                              reloaded and reconciled;
 *   the daily capture          at its hour, once a day: every work package as
 *                              API v3 reports it, independently of the journals;
 *   an incremental refresh     soon after EPM hears of a change — its own write,
 *                              OpenProject's webhook, time logged — and every
 *                              few minutes regardless, for the changes it does
 *                              not hear about.
 *
 * A model that has never been loaded is loaded in full at once. Leases make
 * one server do each of these, and the refresh is single-flight in-process too.
 * A failure is logged and recorded on the run; the next tick tries again.
 */

const FIRST_RUN_DELAY_MS = 15_000;

export interface AnalyticsRefreshScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

async function lastSucceeded(kind?: RefreshKind): Promise<Date | null> {
  const rows = await prisma.$queryRawUnsafe<{ started_at: Date }[]>(
    `SELECT started_at FROM analytics.refresh_run
      WHERE status = 'succeeded' ${kind ? 'AND kind = $1' : 'AND $1::text IS NULL'}
      ORDER BY started_at DESC LIMIT 1`,
    kind ?? null,
  );
  return rows[0]?.started_at ?? null;
}

async function capturedToday(day: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM analytics.snapshot_capture
      WHERE trigger = 'schedule' AND captured_at >= $1::date AND captured_at < $1::date + 1`,
    day,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export function createAnalyticsRefreshScheduler(options: {
  log: FastifyBaseLogger;
  now?: () => Date;
}): AnalyticsRefreshScheduler {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const tickMs = env.EPM_ANALYTICS_CHANGE_CHECK_SECONDS * 1000;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  async function refresh(kind: RefreshKind, trigger: RefreshTrigger): Promise<void> {
    const run = await refreshModel(kind, trigger);
    if (!run) return;
    const fields = {
      runId: run.id,
      kind: run.kind,
      trigger,
      durationMs: run.durationMs,
      reconciled: run.reconciled,
      withinWindow: run.withinWindow,
    };
    if (run.status === 'failed') {
      log.warn({ ...fields, error: run.error }, 'Analytics refresh failed');
      return;
    }
    log.info(fields, 'Analytics model refreshed');
    // Every measure's value for the day, from the same definitions the
    // dashboards use: after each full refresh, and once a day otherwise.
    if (run.kind === 'full' || !(await materialisedToday())) {
      await materialiseMeasures()
        .then((rows) => log.info({ rows }, 'Daily measure values stored'))
        .catch((error: unknown) => {
          log.warn({ err: error }, 'Daily measure values could not be stored');
        });
      // And earned value period by period (BR-303), rebuilt for BI.
      await materialiseEarnedValue()
        .then((rows) => log.info({ rows }, 'Earned value periods stored'))
        .catch((error: unknown) => {
          log.warn({ err: error }, 'Earned value periods could not be stored');
        });
    }
  }

  async function work(): Promise<void> {
    const at = now();
    const day = at.toISOString().slice(0, 10);
    const hour = at.getUTCHours();

    const lastFull = await lastSucceeded('full');
    if (!lastFull || (hour === env.EPM_ANALYTICS_FULL_REFRESH_HOUR_UTC && lastFull.toISOString().slice(0, 10) !== day)) {
      clearModelStale();
      await refresh('full', 'schedule');
      return;
    }

    if (hour === env.EPM_ANALYTICS_CAPTURE_HOUR_UTC && !(await capturedToday(day))) {
      const captured = await withLease('analytics-capture', 30 * 60_000, () => captureWorkPackages('schedule'));
      if (captured.ran) log.info({ captureId: captured.result.id, workPackages: captured.result.workPackages }, 'Work packages captured');
    }

    const last = await lastSucceeded();
    const due = !last || at.getTime() - last.getTime() >= env.EPM_ANALYTICS_REFRESH_INTERVAL_MINUTES * 60_000;
    const changed = await changedSinceLastRefresh();
    if (changed || due) {
      clearModelStale();
      await refresh('incremental', changed ? 'change' : 'schedule');
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      log.warn({ err: error }, 'Analytics refresh tick failed; the next one will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Analytics refresh scheduler already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void tick(), tickMs);
      firstRun.unref();
      timer.unref();
      log.info(
        {
          checkSeconds: env.EPM_ANALYTICS_CHANGE_CHECK_SECONDS,
          intervalMinutes: env.EPM_ANALYTICS_REFRESH_INTERVAL_MINUTES,
          fullRefreshHourUtc: env.EPM_ANALYTICS_FULL_REFRESH_HOUR_UTC,
          captureHourUtc: env.EPM_ANALYTICS_CAPTURE_HOUR_UTC,
        },
        'Analytics model refresh enabled',
      );
    },
    stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = undefined;
      timer = undefined;
      started = false;
    },
    tick,
    get started() {
      return started;
    },
  };
}
