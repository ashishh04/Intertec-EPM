import { env } from '@/config/env';
import { intlLocale, t } from '@/lib/i18n';

/**
 * Thin HTTP client for the EPM backend (BFF).
 *
 * The frontend never talks to OpenProject directly and never holds an
 * OpenProject token. Authentication is a session cookie issued by the EPM
 * backend, which is what `credentials: 'include'` carries.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized() {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }
}

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];

export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

async function parseError(response: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = t('Request failed with status {status}', { status: response.status });
  let details: unknown;

  try {
    const payload = (await response.json()) as { message?: string; code?: string; details?: unknown };
    message = payload.message ?? message;
    code = payload.code;
    details = payload.details;
  } catch {
    // Non-JSON error body — keep the status-based message.
  }

  return new ApiError(message, response.status, code, details);
}

export class ApiClient {
  constructor(private readonly baseUrl: string = env.apiBaseUrl) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body, query, timeoutMs = 20_000, headers, ...rest } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}${buildQuery(query)}`, {
        ...rest,
        signal: controller.signal,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          // The backend answers in the language this page is showing, with its calendar and digits (BR-605, BR-607).
          'Accept-Language': intlLocale(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const failure = await parseError(response);
        // An expired or revoked session is not an error the UI can act on —
        // send the user to sign in again rather than rendering a broken page.
        // /auth/session is exempt: AuthProvider asks it precisely to find out.
        if (failure.status === 401 && !path.startsWith('/auth/')) {
          const target = `${window.location.origin}/login`;
          if (window.location.href !== target) window.location.assign(target);
        }
        throw failure;
      }
      if (response.status === 204) return undefined as T;

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(t('The request timed out.'), 408, 'TIMEOUT');
      }
      throw new ApiError(
        t('Unable to reach the EPM backend. Check your connection and try again.'),
        0,
        'NETWORK',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>(path, { method: 'GET', query });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  /** Replaces a resource whole — the health rules, which are saved as one. */
  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', body });
  }

  delete<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'DELETE', body });
  }

  /**
   * A file the backend generates — a report, an export. Fetched rather than
   * linked so a refusal reads as a message on the page, not as a downloaded
   * file holding an error. The caller names the file: the backend's
   * Content-Disposition is not readable across origins in development.
   */
  async download(path: string, query?: Record<string, QueryValue>, timeoutMs = 60_000): Promise<Blob> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}${buildQuery(query)}`, {
        credentials: 'include',
        signal: controller.signal,
        // A report comes back in the reader's language and direction (BR-604).
        headers: { 'Accept-Language': intlLocale() },
      });
      if (!response.ok) throw await parseError(response);
      return await response.blob();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(t('The request timed out.'), 408, 'TIMEOUT');
      }
      throw new ApiError(t('Unable to reach the EPM backend. Check your connection and try again.'), 0, 'NETWORK');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const apiClient = new ApiClient();
