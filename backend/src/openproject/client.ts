import { currentAuth } from '../auth/context.js';
import { env } from '../config/env.js';
import { OpenProjectError, EpmError } from '../lib/errors.js';
import type { HalCollection, HalLink, OpErrorBody } from './types.js';

/**
 * The only place in the system that speaks to OpenProject.
 *
 * Everything above this file deals in EPM models. The API key is read from the
 * validated environment and never travels further than the Authorization header.
 */

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/** OpenProject caps `pageSize`; requesting more silently returns fewer. */
export const MAX_PAGE_SIZE = 200;

/** Guards against a mis-filtered query walking an entire instance. */
const DEFAULT_MAX_PAGES = 25;

export type FilterOperator =
  | '='
  | '!'
  | '~'
  | '!~'
  | '<>d'
  | '>t-'
  | '<t-'
  | 't-'
  | 't'
  | 'o'
  | 'c'
  | '*'
  | '!*'
  | '>='
  | '<='
  /** Full-text search, used by the `search` and `subjectOrId` filters. */
  | '**';

export interface OpFilter {
  field: string;
  operator: FilterOperator;
  values: (string | number)[];
}

export type SortDirection = 'asc' | 'desc';

export interface CollectionQuery {
  filters?: OpFilter[];
  sortBy?: [string, SortDirection][];
  groupBy?: string;
  /** 1-based page number — OpenProject calls this `offset`. */
  offset?: number;
  pageSize?: number;
  select?: string[];
  /** Extra raw query parameters for endpoint-specific options. */
  extra?: Record<string, string | number | boolean | undefined>;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function buildFilters(filters: OpFilter[]): string {
  return JSON.stringify(
    filters.map(({ field, operator, values }) => ({
      [field]: { operator, values: values.map(String) },
    })),
  );
}

function collectionQueryToParams(query: CollectionQuery): Record<string, string | number> {
  const params: Record<string, string | number> = {};

  // Deliberately serializes an empty array. Omitting `filters` entirely makes
  // OpenProject apply its own default of "open work packages only", which
  // silently hides everything closed; `filters=[]` is how you ask for all of
  // them. Only `undefined` means "send no filter parameter".
  if (query.filters) params.filters = buildFilters(query.filters);
  if (query.sortBy?.length) params.sortBy = JSON.stringify(query.sortBy);
  if (query.groupBy) params.groupBy = query.groupBy;
  if (query.offset !== undefined) params.offset = query.offset;
  if (query.pageSize !== undefined) params.pageSize = Math.min(query.pageSize, MAX_PAGE_SIZE);
  if (query.select?.length) params.select = query.select.join(',');

  for (const [key, value] of Object.entries(query.extra ?? {})) {
    if (value !== undefined) params[key] = String(value);
  }

  return params;
}

/** OpenProject HAL self-links carry the canonical id: `/api/v3/statuses/7` → `"7"`. */
export function idFromHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const match = /\/([^/]+)\/?$/.exec(href);
  return match?.[1];
}

export function linkOf(
  links: Record<string, HalLink | HalLink[] | undefined> | undefined,
  key: string,
): HalLink | undefined {
  const value = links?.[key];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** `_links.status.href` → `"7"`. Returns undefined when the link is null or absent. */
export function linkId(
  links: Record<string, HalLink | HalLink[] | undefined> | undefined,
  key: string,
): string | undefined {
  return idFromHref(linkOf(links, key)?.href);
}

export function linkTitle(
  links: Record<string, HalLink | HalLink[] | undefined> | undefined,
  key: string,
): string | undefined {
  return linkOf(links, key)?.title;
}

function extractUpstreamMessage(payload: unknown, status: number): string {
  const body = payload as OpErrorBody | undefined;
  const nested = body?._embedded?.errors?.[0]?.message;
  return body?.message ?? nested ?? `OpenProject responded with ${status}.`;
}

function delayFor(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return Math.min(250 * 2 ** attempt, 4_000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenProjectClient {
  private readonly baseUrl: string;
  private readonly systemAuthorization: string;

  constructor(baseUrl = env.OPENPROJECT_BASE_URL, apiKey = env.OPENPROJECT_API_KEY) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // OpenProject expects HTTP Basic with the literal username "apikey".
    this.systemAuthorization = `Basic ${Buffer.from(`apikey:${apiKey}`).toString('base64')}`;
  }

  /**
   * Whose credential this call travels on.
   *
   * A signed-in request carries that user's OAuth token, so OpenProject applies
   * their permissions and attributes their edits to them. Without a session
   * this falls back to the configured API key, which is for unattended work
   * only — user-facing routes refuse to run without a session.
   */
  private get authorization(): string {
    const auth = currentAuth();
    return auth ? `Bearer ${auth.accessToken}` : this.systemAuthorization;
  }

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
    const normalized = path.startsWith('/api/v3') ? path : `/api/v3${path.startsWith('/') ? path : `/${path}`}`;
    const url = new URL(`${this.baseUrl}${normalized}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, signal, timeoutMs = env.OPENPROJECT_TIMEOUT_MS } = options;
    const url = this.url(path, query);

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const response = await fetch(url, {
          method,
          signal: composed,
          headers: {
            Authorization: this.authorization,
            Accept: 'application/hal+json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
          await sleep(delayFor(attempt, response.headers.get('retry-after')));
          continue;
        }

        const payload = await response.json().catch(() => undefined);
        throw new OpenProjectError(response.status, extractUpstreamMessage(payload, response.status), {
          upstream: payload,
        });
      } catch (error) {
        if (error instanceof EpmError) throw error;

        // The caller gave up (client disconnected) — don't retry, don't mask it.
        if (signal?.aborted) throw EpmError.timeout('The request was cancelled.');

        if (error instanceof DOMException && error.name === 'TimeoutError') {
          if (attempt < MAX_ATTEMPTS - 1) {
            lastError = error;
            continue;
          }
          throw EpmError.timeout('OpenProject did not respond in time.');
        }

        lastError = error;
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(delayFor(attempt, null));
          continue;
        }
      }
    }

    throw new OpenProjectError(0, 'Unable to reach OpenProject.', { cause: lastError });
  }

  /** One page of a HAL collection. */
  getCollection<T>(path: string, query: CollectionQuery = {}, signal?: AbortSignal) {
    return this.request<HalCollection<T>>(path, {
      query: collectionQueryToParams(query),
      signal,
    });
  }

  /**
   * Walks a HAL collection to completion.
   *
   * Bounded by `maxPages` — an unbounded walk over a large instance is the main
   * way this service could become slow, so overflow is reported rather than
   * silently truncated.
   */
  async getAll<T>(
    path: string,
    query: CollectionQuery = {},
    options: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<{ items: T[]; total: number; truncated: boolean }> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const pageSize = Math.min(query.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

    const items: T[] = [];
    let page = query.offset ?? 1;
    let total = 0;

    for (let visited = 0; visited < maxPages; visited += 1) {
      const collection = await this.getCollection<T>(
        path,
        { ...query, offset: page, pageSize },
        options.signal,
      );

      total = collection.total ?? items.length;
      items.push(...(collection._embedded?.elements ?? []));

      if (items.length >= total || (collection._embedded?.elements?.length ?? 0) === 0) {
        return { items, total, truncated: false };
      }
      page += 1;
    }

    return { items, total, truncated: items.length < total };
  }
}

export const openProject = new OpenProjectClient();
