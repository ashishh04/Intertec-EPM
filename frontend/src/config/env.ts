/**
 * Environment configuration.
 *
 * The frontend only ever talks to the Nexus backend (BFF). It never receives an
 * OpenProject URL, API token or credential — those live server-side.
 */

export type DataSource = 'mock' | 'api';
export type AppEnvironment = 'demo' | 'development' | 'staging' | 'production';

const raw = import.meta.env;

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export const env = {
  /** Base URL of the Nexus backend API. Never an OpenProject URL. */
  apiBaseUrl: readString(raw.VITE_API_BASE_URL, 'http://localhost:8000/api'),

  /** Which repository implementation backs the service layer. */
  dataSource: readString(raw.VITE_DATA_SOURCE, 'mock') as DataSource,

  /** Drives the environment badge in the header. */
  appEnv: readString(raw.VITE_APP_ENV, 'demo') as AppEnvironment,

  isProduction: readString(raw.VITE_APP_ENV, 'demo') === 'production',
} as const;

/** True while the app is served from bundled demo data rather than a live backend. */
export const isDemoData = env.dataSource === 'mock';

export const featureFlags = {
  /** Renders the "Ask Nexus" entry point. The assistant itself is not implemented. */
  nexusAi: true,
  /** Reserved for the future WebSocket/SSE cache-invalidation layer. */
  realtime: false,
} as const;

export const APP_NAME = 'NEXUS';
export const APP_DESCRIPTOR = 'Unified Project & Delivery Platform';
export const ORG_NAME = 'Intertec Systems';
