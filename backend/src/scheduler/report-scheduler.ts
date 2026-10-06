import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { withLease } from '../domain/job-lease.js';
import { purgeExpired, runDue } from '../domain/scheduled-reports.js';

/**
 * Sends scheduled reports when they are due (BR-207).
 *
 * A short tick, behind a lease so one server runs the due reports; each
 * occurrence is also guarded by its own unique run, so even two servers that
 * both thought they held the lease would send it once. An occurrence noticed
 * within its window is run; one noticed later — after the server was down,
 * say — is logged as missed rather than sent at the wrong time. Once a day
 * the run log and the rendered files past their retention are dropped.
 */

const FIRST_RUN_DELAY_MS = 20_000;

export interface ReportScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createReportScheduler(options: { log: FastifyBaseLogger; now?: () => Date }): ReportScheduler {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const tickMs = env.EPM_REPORT_SCHEDULER_SECONDS * 1000;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;
  let lastPurgeDay: string | undefined;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const at = now();
      const outcome = await withLease('report-scheduler', 10 * 60_000, async () => {
        const result = await runDue(at);
        const day = at.toISOString().slice(0, 10);
        if (lastPurgeDay !== day) {
          const purged = await purgeExpired(at);
          lastPurgeDay = day;
          if (purged.runs + purged.artifacts > 0) log.info(purged, 'Expired report runs and files dropped');
        }
        return result;
      });
      if (outcome.ran && (outcome.result.ran > 0 || outcome.result.missed > 0)) {
        log.info(outcome.result, 'Scheduled reports processed');
      }
    } catch (error) {
      log.warn({ err: error }, 'Scheduled report tick failed; the next one will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Report scheduler already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void tick(), tickMs);
      firstRun.unref();
      timer.unref();
      log.info({ tickSeconds: env.EPM_REPORT_SCHEDULER_SECONDS }, 'Report scheduler enabled');
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
