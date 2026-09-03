import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { notifySnapshotFailure } from '../domain/notifications.js';
import { runSnapshot } from '../routes/analytics.js';

/**
 * Periodic analytics capture.
 *
 * The smallest thing that makes trends useful: a timer that calls the snapshot
 * service the manual endpoint already calls. There is no job table, no queue
 * and no worker, because the deployment is one Node process beside one Postgres
 * and none of that would be earning its keep.
 *
 * It runs **outside any request context**, which is not incidental — that is how
 * it authenticates. `OpenProjectClient` reads the async-local auth context and
 * falls back to the configured service key when there is none, a path
 * `auth/context.ts` describes as being for exactly this. So the scheduler
 * invents no user, hardcodes no identity and holds no credential of its own.
 *
 * Everything about failure is deliberate: a capture that throws is caught,
 * logged and forgotten, the timer keeps running, and the backend never notices.
 * A missing day is a gap, and gaps are honest.
 */

/** How long after startup the first capture runs. */
const FIRST_RUN_DELAY_MS = 30_000;

export interface SnapshotScheduler {
  /** Begins the timer. Safe to call once; a second call is refused and logged. */
  start(): void;
  /** Clears the timer. Safe to call when never started. */
  stop(): void;
  /**
   * Runs one capture now, with the same guards the timer uses. Exported so a
   * test can exercise a tick without waiting for real time to pass.
   */
  tick(): Promise<void>;
  readonly started: boolean;
  /** True while a capture is in flight. */
  readonly running: boolean;
}

export interface SchedulerOptions {
  log: FastifyBaseLogger;
  /** Overridable so tests can supply a stub instead of hitting OpenProject. */
  capture?: (signal: AbortSignal) => Promise<{ sampledOn: string; records: number; scopes: unknown }>;
  intervalMs?: number;
  firstRunDelayMs?: number;
  /** A capture that outlives this is abandoned so it cannot block the next one. */
  timeoutMs?: number;
}

export function createAnalyticsSnapshotScheduler(options: SchedulerOptions): SnapshotScheduler {
  const log = options.log;
  const capture = options.capture ?? runSnapshot;
  const intervalMs = options.intervalMs ?? env.EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES * 60_000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  async function tick(): Promise<void> {
    // A capture slower than the interval must not pile up behind itself. The
    // tick is skipped rather than queued: the next one will capture the same
    // day anyway, so nothing is lost by dropping this one.
    if (running) {
      log.warn('Analytics snapshot skipped: the previous capture is still running');
      return;
    }

    running = true;
    const startedAt = Date.now();
    log.debug('Analytics snapshot starting');

    try {
      const result = await capture(AbortSignal.timeout(timeoutMs));
      log.info(
        {
          sampledOn: result.sampledOn,
          records: result.records,
          scopes: result.scopes,
          durationMs: Date.now() - startedAt,
        },
        'Analytics snapshot captured',
      );
    } catch (error) {
      // Warn rather than error: a failed capture leaves a gap, which the charts
      // already render honestly, and the next tick will try again. It is not a
      // fault the service needs to escalate.
      log.warn(
        { err: error, durationMs: Date.now() - startedAt },
        'Analytics snapshot failed; the period will be left as a gap',
      );

      // And tell whoever administers analytics, once for the day rather than
      // once per retry. Only the message travels — a stack trace carries paths
      // and an upstream error can carry a request URL.
      const reason = error instanceof Error ? error.message : 'The capture did not complete.';
      await notifySnapshotFailure({ day: new Date().toISOString().slice(0, 10), reason })
        .catch((notifyError: unknown) => {
          log.warn({ err: notifyError }, 'Could not notify the snapshot failure');
        });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        // Hot reload in development can build the app twice; a second timer
        // would double the work for no benefit.
        log.warn('Analytics snapshot scheduler already started; ignoring');
        return;
      }
      started = true;

      // Deferred, so startup is never blocked on OpenProject being reachable —
      // and so a restart after downtime records today promptly rather than
      // waiting a whole interval. No missed day is backfilled: writing today's
      // numbers against yesterday's date would be a fabrication.
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);

      // Neither timer should hold the process open on its own.
      firstRun.unref();
      timer.unref();

      log.info(
        { intervalMinutes: Math.round(intervalMs / 60_000), firstRunInSeconds: firstRunDelayMs / 1000 },
        'Analytics snapshot scheduler enabled',
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
    get running() {
      return running;
    },
  };
}
