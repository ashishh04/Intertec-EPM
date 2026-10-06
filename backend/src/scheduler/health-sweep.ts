import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { recalculateNow } from '../domain/health.js';
import { withLease } from '../domain/job-lease.js';

/**
 * The scheduled health sweep (BR-205).
 *
 * Health is recalculated whenever EPM sees something change — an edit made
 * through it, a webhook from the instance. The sweep catches everything else:
 * time logged directly in the instance with no webhook configured, a due date
 * that has simply passed overnight and made work overdue. It recalculates every
 * active project and re-reads every project's actual cost, so stored health is
 * never older than one interval, whatever happened upstream.
 *
 * Same shape as the other schedulers: a timer behind a lease — so with several
 * servers one of them sweeps — runs outside any request so the service key is used, and a failed run is logged and left for
 * the next one. The first run comes shortly after startup, so a fresh
 * deployment has every project calculated without waiting an interval.
 */

const FIRST_RUN_DELAY_MS = 20_000;

export interface HealthSweep {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createHealthSweep(options: {
  log: FastifyBaseLogger;
  intervalMs?: number;
  firstRunDelayMs?: number;
}): HealthSweep {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_HEALTH_SWEEP_INTERVAL_MINUTES * 60_000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      log.warn('Health sweep skipped: the previous sweep is still running');
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      // One server recalculates every project per sweep, not each of them.
      const outcome = await withLease('health-sweep', 30 * 60_000, () => recalculateNow('all', 'sweep'));
      if (outcome.ran) {
        log.info({ projects: outcome.result.size, durationMs: Date.now() - startedAt }, 'Health sweep completed');
      }
    } catch (error) {
      log.warn({ err: error, durationMs: Date.now() - startedAt }, 'Health sweep failed; the next one will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Health sweep already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);
      firstRun.unref();
      timer.unref();
      log.info(
        { intervalMinutes: Math.round(intervalMs / 60_000), firstRunInSeconds: firstRunDelayMs / 1000 },
        'Health sweep enabled',
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
