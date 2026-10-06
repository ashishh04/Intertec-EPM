import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { sweepEscalations } from '../domain/escalation.js';
import { withLease } from '../domain/job-lease.js';
import { pruneRuleEvents } from '../domain/rule-events.js';

/**
 * The escalation sweep (BR-218): evaluates the escalation policies on a
 * schedule, raising what has reached a new level and resolving what no longer
 * qualifies. Behind a lease, so with several servers one of them runs each
 * sweep. Also trims the rule event queue of what it no longer needs.
 */

export interface EscalationSweep {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createEscalationSweep(options: { log: FastifyBaseLogger; intervalMs?: number }): EscalationSweep {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_ESCALATION_SWEEP_INTERVAL_MINUTES * 60_000;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const outcome = await withLease('escalation-sweep', 15 * 60_000, async () => {
        const result = await sweepEscalations();
        const pruned = await pruneRuleEvents();
        return { ...result, pruned };
      });
      if (outcome.ran && (outcome.result.raised || outcome.result.resolved || outcome.result.pruned)) {
        log.info(outcome.result, 'Escalation sweep: escalations raised and resolved');
      }
    } catch (error) {
      log.warn({ err: error }, 'Escalation sweep failed; the next one will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      log.info({ intervalMinutes: Math.round(intervalMs / 60_000) }, 'Escalation sweep enabled');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
