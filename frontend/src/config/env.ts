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

export const env = {
  /** Base URL of the EPM backend API. Never an OpenProject URL. */
  apiBaseUrl: readString(raw.VITE_API_BASE_URL, 'http://localhost:8000/api'),

  /** Drives the environment badge in the header. */
  appEnv: readString(raw.VITE_APP_ENV, 'development') as AppEnvironment,

  isProduction: readString(raw.VITE_APP_ENV, 'development') === 'production',
} as const;

export const featureFlags = {
  /** Renders the "Ask EPM" entry point. The assistant itself is not implemented. */
  epmAi: true,
  /** Reserved for the future WebSocket/SSE cache-invalidation layer. */
  realtime: false,
} as const;

export const APP_NAME = 'EPM';
export const APP_DESCRIPTOR = 'Unified Project & Delivery Platform';
export const ORG_NAME = 'Intertec Systems';
