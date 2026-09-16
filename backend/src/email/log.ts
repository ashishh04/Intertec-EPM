import type { FastifyBaseLogger } from 'fastify';

/**
 * The email module's logger.
 *
 * Email is enqueued from places that have no request and no app handle — a
 * domain function called from the scheduler, the outbox worker itself — so the
 * logger cannot be threaded in as a parameter without every caller carrying it.
 * The app hands its own logger over once at startup; until then, and in a
 * script that never builds the app, a console-backed stand-in keeps the same
 * `(object, message)` shape so nothing here has to care which it got.
 */

export interface EmailLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const fallback: EmailLogger = {
  debug: () => undefined,
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

let current: EmailLogger = fallback;

/** Adopts the application's logger. Called once from `buildApp`. */
export function useEmailLogger(log: FastifyBaseLogger): void {
  current = {
    debug: (obj, msg) => log.debug(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
}

/** Always the logger in force now, not the one captured at import time. */
export const emailLog: EmailLogger = {
  debug: (obj, msg) => current.debug(obj, msg),
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};
