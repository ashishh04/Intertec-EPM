import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { checkSchedule } from '../domain/schedule.js';

/**
 * The critical path check (BR-104).
 *
 * Float is recalculated as soon as EPM makes a change that can move it. The
 * check catches every other change: a date moved or a relation drawn in
 * OpenProject's own screens, a holiday added to its calendar, a schedule field
 * edited by hand. Each tick asks OpenProject for two digests — the network and
 * the values its schedule fields hold — and runs a pass only when either
 * differs from the last pass's. A quiet tick costs one small query there and
 * one row read here.
 *
 * Same shape as the other schedulers. The pass itself takes the lease, so with
 * several servers one of them runs it; a failed check is logged and the next
 * tick tries again. The first tick comes shortly after startup, so a fresh
 * deployment has its figures without waiting an interval.
 */

const FIRST_RUN_DELAY_MS = 15_000;

export interface ScheduleCheck {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createScheduleCheck(options: {
  log: FastifyBaseLogger;
  intervalMs?: number;
  firstRunDelayMs?: number;
}): ScheduleCheck {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_SCHEDULE_CHECK_SECONDS * 1000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let checking = false;

  async function tick(): Promise<void> {
    if (checking) return;
    checking = true;
    const startedAt = Date.now();
    try {
      const outcome = await checkSchedule();
      if (outcome.ran) log.info({ reason: outcome.reason, durationMs: Date.now() - startedAt }, 'Critical path recalculated');
    } catch (error) {
      log.warn({ err: error }, 'Critical path check failed; the next one will retry');
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Critical path check already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);
      firstRun.unref();
      timer.unref();
      log.info({ intervalSeconds: Math.round(intervalMs / 1000) }, 'Critical path check enabled');
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
