import type { FastifyBaseLogger } from 'fastify';

import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { claimRuleEvents, finishRuleEvent, onRuleEvent } from '../domain/rule-events.js';
import { processRuleEvent } from '../domain/rules.js';

/**
 * The rule worker (BR-216, BR-217): takes queued events and runs the rules on
 * them. It polls every few seconds, and is woken at once when this server
 * queues an event, so a rule acts within moments of the change it watches.
 * Events are claimed per row, so several servers can run it side by side.
 */

export interface RuleWorker {
  start(): void;
  stop(): void;
  /** Works through everything queued now. Returns how many events it handled. */
  drain(): Promise<number>;
}

export function createRuleWorker(options: { log: FastifyBaseLogger; intervalMs?: number }): RuleWorker {
  const { log } = options;
  const intervalMs = options.intervalMs ?? env.EPM_RULES_POLL_SECONDS * 1000;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  let stopped = false;

  async function drain(): Promise<number> {
    if (running) {
      // Picked up when the current pass finishes.
      again = true;
      return 0;
    }
    running = true;
    let handled = 0;
    try {
      do {
        again = false;
        for (;;) {
          const events = await claimRuleEvents(20);
          if (events.length === 0) break;
          for (const event of events) {
            try {
              await processRuleEvent(event);
              await finishRuleEvent(event);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log.warn({ err: error, eventId: event.id, attempts: event.attempts }, 'A rule event failed; it will be retried');
              await finishRuleEvent(event, message);
            }
            handled += 1;
          }
        }
      } while (again && !stopped);
    } catch (error) {
      log.warn({ err: error }, 'The rule worker failed; the next poll will retry');
    } finally {
      running = false;
    }
    return handled;
  }

  // Never in the context of the request that queued the event: rules run as
  // the system and the automation account, not as whoever made the change.
  const wake = () => setImmediate(() => runAsSystem(() => void drain()));

  return {
    start() {
      if (timer) return;
      stopped = false;
      onRuleEvent(wake);
      timer = setInterval(() => void drain(), intervalMs);
      timer.unref();
      log.info({ intervalSeconds: Math.round(intervalMs / 1000) }, 'Rule worker enabled');
    },
    stop() {
      stopped = true;
      onRuleEvent(() => undefined);
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    drain,
  };
}
