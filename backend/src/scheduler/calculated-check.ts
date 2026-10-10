import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { checkCalculated } from '../domain/calculated-fields.js';

/**
 * The calculated field check (BR-408).
 *
 * Values are recalculated as soon as EPM makes a change that can move one. The
 * check catches every other change: a date or an estimate edited in
 * OpenProject's own screens, time logged there, a custom value typed, a
 * holiday added, a calculated value typed over by hand — and the day turning,
 * for a formula that reads TODAY(). Each tick asks OpenProject for two digests
 * — of everything formulas read, and of the values its calculated fields hold
 * — and runs a pass only when either differs from the last pass's, or the
 * definitions or the day have. A quiet tick costs one small query there and a
 * few rows here.
 *
 * The same shape as the critical path check. The pass takes the lease, so with
 * several servers one of them runs it; a failed check is logged and the next
 * tick tries again; the first tick comes shortly after startup.
 */

const FIRST_RUN_DELAY_MS = 20_000;

export interface CalculatedCheck {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly started: boolean;
}

export function createCalculatedCheck(options: { log: FastifyBaseLogger; intervalMs?: number; firstRunDelayMs?: number }): CalculatedCheck {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_CALCULATED_CHECK_SECONDS * 1000;
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
      const outcome = await checkCalculated();
      if (outcome.ran) log.info({ reason: outcome.reason, durationMs: Date.now() - startedAt }, 'Calculated fields recalculated');
    } catch (error) {
      log.warn({ err: error }, 'Calculated field check failed; the next one will retry');
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Calculated field check already started; ignoring');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), intervalMs);
      firstRun.unref();
      timer.unref();
      log.info({ intervalSeconds: Math.round(intervalMs / 1000) }, 'Calculated field check enabled');
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
