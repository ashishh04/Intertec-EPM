import type { FastifyBaseLogger } from 'fastify';

import { retryDue } from '../domain/integration-inbox.js';
import { withLease } from '../domain/job-lease.js';

/**
 * Retries inbound integration events whose processing failed (BR-506), on
 * their back-off, until they succeed or are dead-lettered; prunes processed
 * ones past their retention. Every minute; one server at a time.
 */

const TICK_MS = 60_000;

export function createIntegrationRetry(options: { log: FastifyBaseLogger }) {
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const outcome = await withLease('integration-retry', 5 * 60_000, () => retryDue()).catch((error: unknown) => {
      options.log.warn({ err: error }, 'Retrying integration events failed');
      return { ran: false as const };
    });
    if (outcome.ran && (outcome.result.retried > 0 || outcome.result.pruned > 0)) {
      options.log.info(outcome.result, 'Integration events retried');
    }
  }

  return {
    start() {
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
