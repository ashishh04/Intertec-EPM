import type { FastifyBaseLogger } from 'fastify';

import { runForecasts } from '../domain/forecasting-store.js';
import { withLease } from '../domain/job-lease.js';

/**
 * Refreshes the delivery forecasts (BR-509) on a schedule: the model trained
 * again on the history as it stands, every active project forecast, the
 * recommendations proposed afresh. Every six hours, the first a few minutes
 * after start; one server at a time.
 */

const TICK_MS = 6 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;

export function createForecastRefresh(options: { log: FastifyBaseLogger }) {
  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const outcome = await withLease('forecast-refresh', 30 * 60_000, () => runForecasts('schedule', null)).catch((error: unknown) => {
      options.log.warn({ err: error }, 'Refreshing the forecasts failed');
      return { ran: false as const };
    });
    if (outcome.ran) options.log.info(outcome.result, 'Forecasts refreshed');
  }

  return {
    start() {
      firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = undefined;
      timer = undefined;
    },
  };
}
