import { currentAuth } from '../auth/context.js';
import { env } from '../config/env.js';
import { OpenProjectError, EpmError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import type { HalCollection, HalLink, OpErrorBody } from './types.js';

/**
 * The only place in the system that speaks to OpenProject.
 *
 * Everything above this file deals in EPM models. The API key is read from the
 * validated environment and never travels further than the Authorization header.
 */

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/*
 * Sent on every request to OpenProject, and not optional in a deployment.
 *
 * OpenProject runs with OPENPROJECT_HTTPS=true, because it is reached over TLS
 * by the people using it. That makes it answer any request it believes arrived
 * over plain HTTP with a 301 to the https form of the same URL. We reach it
 * inside the compose network as `http://openproject`, so every call is exactly
 * that kind of request — and the redirect points at `https://openproject`,
 * where nothing is listening, so fetch does not fail cleanly with a status but
 * throws outright.
 *
 * Saying the hop in front of us already terminated TLS, which is true — Caddy
 * did — makes OpenProject answer rather than redirect. This is the same header
 * a reverse proxy would set, and OpenProject is configured to trust it.
 */
export const FORWARDED_HEADERS = { 'X-Forwarded-Proto': 'https' } as const;

/** OpenProject caps `pageSize`; requesting more silently returns fewer. */
export const MAX_PAGE_SIZE = 200;

/**
 * Guards against a mis-filtered query walking an entire instance.
 *
 * At `MAX_PAGE_SIZE` this allows 20,000 records, which is above what any
 * caller here legitimately needs and well clear of the sizes that were
 * silently clipping: memberships grow as projects × people, so an instance
 * with a hundred projects and twenty-five people each already passed the
 * previous 2,500.
 */
const DEFAULT_MAX_PAGES = 100;

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

/** A value array becomes repeated `key[]=` parameters, which is what OpenProject expects. */
export type QueryParams = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The path is relative to the instance root rather than `/api/v3`.
   *
   * For the EPM-only endpoints the mounted initializer adds under
   * `/epm_admin/*` (see backend/openproject/README.md). Same credential, same
   * retries, same error mapping; only the prefix differs.
   */
  root?: boolean;
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

/**
 * The sentence a failed upstream call shows the user.
 *
 * `EpmError.message` is sent to the browser, so nothing here may name the
 * system behind EPM — white-labelling is the point, and an error is exactly
 * when a product tends to give itself away. `upstream` carries the real detail
 * for the log instead.
 */
function extractUpstreamMessage(payload: unknown, status: number): string {
  const body = payload as OpErrorBody | undefined;
  const nested = body?._embedded?.errors?.[0]?.message;
  return body?.message ?? nested ?? `The delivery service responded with ${status}.`;
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

  private url(path: string, query: QueryParams = {}, root = false) {
    const slashed = path.startsWith('/') ? path : `/${path}`;
    const normalized = root || path.startsWith('/api/v3') ? slashed : `/api/v3${slashed}`;
    const url = new URL(`${this.baseUrl}${normalized}`);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;

      // OpenProject reads list parameters as repeated `key[]=` entries, not as
      // a JSON array — sending one is answered with an internal error.
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(`${key}[]`, String(entry));
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, signal, timeoutMs = env.OPENPROJECT_TIMEOUT_MS, root = false } = options;
    const url = this.url(path, query, root);
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const response = await fetch(url, {
          method,
          signal: composed,
          headers: {
            ...FORWARDED_HEADERS,
            Authorization: this.authorization,
            Accept: 'application/hal+json',
            // FormData carries its own multipart content type, including the
            // boundary, which only fetch can generate. Setting one here would
            // produce a body OpenProject cannot parse.
            //
            // Every other write carries it, body or not: OpenProject answers a
            // bodyless POST with 406 "Missing content-type header", which is
            // how marking a notification read silently did nothing. A GET is
            // left alone — a content type on a request with no entity is
            // meaningless, and some proxies object.
            ...(!isFormData && (body !== undefined || method !== 'GET')
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
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
          throw EpmError.timeout('The delivery service did not respond in time.');
        }

        lastError = error;
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(delayFor(attempt, null));
          continue;
        }
      }
    }

    throw new OpenProjectError(0, 'Unable to reach the delivery service.', { cause: lastError });
  }

  /**
   * The raw response, for bodies that should not be parsed.
   *
   * Attachment downloads are streamed straight through to the caller, so the
   * bytes are never held in memory here and never re-encoded. Retries are
   * skipped deliberately: a stream cannot be replayed once it has started.
   */
  async stream(path: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(env.OPENPROJECT_TIMEOUT_MS);

    return fetch(this.url(path), {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...FORWARDED_HEADERS, Authorization: this.authorization, Accept: '*/*' },
    });
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

    const truncated = items.length < total;

    // Reported here rather than left to each caller. Of the places that walk a
    // collection, almost none read the flag — so a walk that stopped short
    // returned a short list that looked complete, and the numbers built on it
    // were quietly wrong rather than visibly broken. One line in the logs is
    // the difference between noticing that and not.
    if (truncated) {
      appLog.warn(
        { path, returned: items.length, total, maxPages, pageSize },
        'Collection walk hit its page limit; the result is incomplete',
      );
    }

    return { items, total, truncated };
  }
}

export const openProject = new OpenProjectClient();

/**
 * Whether OpenProject will answer right now.
 *
 * `/api/v3` is the API root: cheap and present on every version. Any reply
 * under 500 counts as up, including the 401 an instance with `login_required`
 * gives an anonymous probe — being refused proves something answered. What
 * this is really watching for is the 503 OpenProject's own front end returns
 * for the several minutes Rails takes to boot, which is exactly when traffic
 * should go elsewhere.
 *
 * A short timeout of its own, because a readiness probe that hangs is worse
 * than one that fails.
 */
export async function openProjectReady(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const response = await fetch(`${env.OPENPROJECT_BASE_URL}/api/v3`, {
      signal: AbortSignal.timeout(5_000),
      headers: { ...FORWARDED_HEADERS, Accept: 'application/hal+json' },
    });

    /*
     * 2xx is the healthy answer; 401 and 403 are too, because an unauthenticated
     * probe being refused still proves OpenProject is up and speaking HAL.
     *
     * Everything else is not ready, and the previous `status < 500` is why this
     * is spelled out. A misconfigured host allowlist answers every single API
     * call with 400, and a stack in that state passed readiness and reported
     * itself healthy while nothing touching OpenProject worked — no sign-in, no
     * projects, no tasks. A check that cannot fail is not a check.
     */
    return response.ok || response.status === 401 || response.status === 403
      ? { ok: true }
      : { ok: false, detail: `responded ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
  }
}
