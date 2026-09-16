/**
 * Environment configuration.
 *
 * The frontend only ever talks to the EPM backend (BFF). It never receives an
 * OpenProject URL, API token or credential — those live server-side.
 */

export type AppEnvironment = 'development' | 'staging' | 'production';

const raw = import.meta.env;

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

const appEnv = readString(raw.VITE_APP_ENV, 'development') as AppEnvironment;

/**
 * Where the backend lives.
 *
 * Vite inlines this at build time, so a production bundle built without
 * `VITE_API_BASE_URL` set would carry the development fallback and every
 * browser would call its own machine — the app wholly broken, and the backend
 * logs silent because nothing reaches them. Failing the build is the only
 * point at which that is cheap to notice, so a production build that has not
 * been told the address refuses to start rather than shipping localhost.
 */
function resolveApiBaseUrl(): string {
  const configured = raw.VITE_API_BASE_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;

  if (appEnv === 'production') {
    throw new Error(
      'VITE_API_BASE_URL is not set. A production build must be given the backend address ' +
        '(see frontend/.env.production); otherwise the bundle points at localhost.',
    );
  }

  return 'http://localhost:8000/api';
}

export const env = {
  /** Base URL of the EPM backend API. Never an OpenProject URL. */
  apiBaseUrl: resolveApiBaseUrl(),

  /** Drives the environment badge in the header. */
  appEnv,

  isProduction: appEnv === 'production',
} as const;

export const featureFlags = {
  /** Renders Pragnya, the in-app assistant, and its entry points. */
  pragnya: true,
  /** Reserved for the future WebSocket/SSE cache-invalidation layer. */
  realtime: false,
} as const;

export const APP_NAME = 'EPM';
export const APP_DESCRIPTOR = 'Unified Project & Delivery Platform';
export const ORG_NAME = 'Intertec Systems';
