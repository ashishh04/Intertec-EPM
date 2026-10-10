import type { FastifyBaseLogger } from 'fastify';

import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { render } from '../lib/i18n.js';
import { generateDueSeriesLeased } from '../domain/task-series.js';

/**
 * Recurring tasks (BR-106): every tick, each active series whose next task's
 * lead time has come has its due tasks made, as the automation account.
 *
 * Same shape as the other schedulers: a timer behind a lease, so with several
 * servers one of them makes the tasks, and each occurrence is claimed before
 * its work package is made, so even two runs at once cannot make one twice. A
 * failed run is logged and the next tick tries again. The first tick comes
 * shortly after startup, so tasks that fell due while the server was down are
 * made without waiting an interval.
 */

const FIRST_RUN_DELAY_MS = 30_000;

export interface RecurrenceScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createRecurrenceScheduler(options: {
  log: FastifyBaseLogger;
  intervalMs?: number;
  firstRunDelayMs?: number;
}): RecurrenceScheduler {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_RECURRENCE_INTERVAL_MINUTES * 60_000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const startedAt = Date.now();
    try {
      const outcome = await runAsSystem(() => generateDueSeriesLeased());
      if (outcome.ran && (outcome.result.generated || outcome.result.failed)) {
        log.info(
          {
            series: outcome.result.series,
            generated: outcome.result.generated,
            failed: outcome.result.failed,
            problems: outcome.result.problems.map((problem) => render('en', problem)),
            durationMs: Date.now() - startedAt,
          },
          'Recurring tasks made',
        );
      }
    } catch (error) {
      log.warn({ err: error }, 'Recurring task generation failed; the next tick will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Recurring task generation already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);
      firstRun.unref();
      timer.unref();
      log.info({ intervalMinutes: Math.round(intervalMs / 60_000) }, 'Recurring task generation enabled');
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
