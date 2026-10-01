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
 * Vite inlines this at build time, so whatever is chosen here is frozen into
 * the bundle — which is why a production build must not name a host. The
 * published image is pulled onto whatever domain a deployment uses, and an
 * absolute URL would pin one image to one domain, making every move a rebuild.
 *
 * `/api` is relative, so the browser resolves it against the origin that served
 * the page. Caddy serves the bundle and proxies `/api` to the backend on that
 * same origin (see frontend/Caddyfile), so one bundle is correct on every
 * domain. Same origin is also what keeps the session cookie simple: no
 * preflight, and `SameSite=lax` behaving as intended.
 *
 * `VITE_API_BASE_URL` remains an override, for the one case a relative path
 * cannot express — a backend on a different origin from the app. Setting it
 * ties the resulting bundle to that address.
 */
function resolveApiBaseUrl(): string {
  const configured = raw.VITE_API_BASE_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;

  if (appEnv === 'production') return '/api';

  return 'http://localhost:8000/api';
}

export const env = {
  /** Base URL of the EPM backend API. Never an OpenProject URL. */
  apiBaseUrl: resolveApiBaseUrl(),

  /** Drives the environment badge in the header. */
  appEnv,

  /*
   * ISO 4217 code for the currency internal hourly rates are quoted in.
   *
   * Only ever a label — on the rate field in the staffing dialog, and nowhere
   * else. Every figure the product actually computes carries the currency the
   * backend reported alongside it, because the backend is authoritative for
   * both the number and its unit. Keep this in step with EPM_CURRENCY there so
   * the input agrees with the report it feeds.
   */
  currency: readString(raw.VITE_CURRENCY, 'AED').toUpperCase(),

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
