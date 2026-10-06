import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { sweepApprovals } from '../domain/approvals.js';
import { withLease } from '../domain/job-lease.js';

/**
 * The approval sweep (BR-214, BR-212).
 *
 * Every few minutes: raise an escalation for each step that has outlived its
 * SLA, and keep delegations current — attach one whose period has started to
 * the approvals waiting on its delegator, detach one that has ended. Same
 * shape as the other schedulers: a timer behind a lease, a failed run logged
 * and left for the next.
 */

export interface ApprovalSweep {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createApprovalSweep(options: { log: FastifyBaseLogger; intervalMs?: number }): ApprovalSweep {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_APPROVAL_SWEEP_INTERVAL_MINUTES * 60_000;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const outcome = await withLease('approval-sweep', 10 * 60_000, () => sweepApprovals());
      if (outcome.ran && (outcome.result.breached || outcome.result.attached || outcome.result.detached)) {
        log.info(outcome.result, 'Approval sweep: escalations raised and delegations updated');
      }
    } catch (error) {
      log.warn({ err: error }, 'Approval sweep failed; the next one will retry');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      log.info({ intervalMinutes: Math.round(intervalMs / 60_000) }, 'Approval sweep enabled');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
