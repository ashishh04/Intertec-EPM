import type { FastifyBaseLogger } from 'fastify';

/**
 * A logger for code that runs beneath the request layer.
 *
 * The OpenProject client, the caches and the mappers are called from request
 * handlers, from schedulers, and from scripts that never build the app, so a
 * logger cannot be threaded in as a parameter without every caller carrying
 * one. The app hands its own over once at startup; until then a console-backed
 * stand-in keeps the same `(object, message)` shape, so nothing here has to
 * care which it got.
 *
 * The same arrangement `email/log.ts` makes for the same reason.
 */

export interface AppLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const fallback: AppLogger = {
  debug: () => undefined,
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

let current: AppLogger = fallback;

/** Adopts the application's logger. Called once from `buildApp`. */
export function useAppLogger(log: FastifyBaseLogger): void {
  current = {
    debug: (obj, msg) => log.debug(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
}

/** Always the logger in force now, not the one captured at import time. */
export const appLog: AppLogger = {
  debug: (obj, msg) => current.debug(obj, msg),
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};
