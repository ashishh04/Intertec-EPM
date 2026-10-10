import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { sampleBurndown } from '../domain/burndown.js';
import { withLease } from '../domain/job-lease.js';

/**
 * The burndown sampler: keeps each sprint's daily burndown samples
 * (`domain/burndown.ts`). Every pass rewrites today's figure for every running
 * sprint and rebuilds any past day that has none from the journal history, so
 * a chart has a line from the sprint's first day on.
 *
 * Same shape as the other schedulers: a timer behind a lease — so with several
 * servers one of them samples — run outside any request so the service key is
 * used; a failed pass is logged and left for the next. The first pass comes
 * shortly after startup.
 */

const FIRST_RUN_DELAY_MS = 45_000;

export interface BurndownSampler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createBurndownSampler(options: {
  log: FastifyBaseLogger;
  intervalMs?: number;
  firstRunDelayMs?: number;
}): BurndownSampler {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_BURNDOWN_SAMPLER_INTERVAL_MINUTES * 60_000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      log.warn('Burndown sampling skipped: the previous pass is still running');
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const outcome = await withLease('burndown-sampler', 10 * 60_000, () => sampleBurndown());
      if (outcome.ran && (outcome.result.today > 0 || outcome.result.rebuilt > 0)) {
        log.info({ ...outcome.result, durationMs: Date.now() - startedAt }, 'Burndown samples written');
      }
    } catch (error) {
      log.warn({ err: error, durationMs: Date.now() - startedAt }, 'Burndown sampling failed; the next pass will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Burndown sampler already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);
      firstRun.unref();
      timer.unref();
      log.info(
        { intervalMinutes: Math.round(intervalMs / 60_000), firstRunInSeconds: firstRunDelayMs / 1000 },
        'Burndown sampler enabled',
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
