import { env } from '@/config/env';

/**
 * Thin HTTP client for the Nexus backend (BFF).
 *
 * The frontend never talks to OpenProject directly and never holds an
 * OpenProject token. Authentication is a session cookie issued by the Nexus
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
  let message = `Request failed with status ${response.status}`;
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
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) throw await parseError(response);
      if (response.status === 204) return undefined as T;

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('The request timed out.', 408, 'TIMEOUT');
      }
      throw new ApiError(
        'Unable to reach the Nexus backend. Check your connection and try again.',
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

  delete<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'DELETE', body });
  }
}

export const apiClient = new ApiClient();
