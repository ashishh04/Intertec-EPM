import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, type QueryParams } from '../openproject/client.js';
import { referenceCache } from '../lib/cache.js';
import { getCatalog } from '../mapping/catalog.js';
import { toEpmTask } from '../mapping/tasks.js';
import {
  toEpmQuery,
  toFilterSchema,
  type QueryColumn,
  type QueryFilterSchema,
} from '../mapping/queries.js';
import type { HalCollection, OpWorkPackage } from '../openproject/types.js';
import type { EpmTask } from '../types/epm.js';

/**
 * Work package queries, backed by OpenProject's Queries API.
 *
 * A query is OpenProject's own object: filters, columns, sort order and
 * grouping, saved or ad-hoc. Wrapping it rather than reimplementing it means
 * filtering happens upstream, over the whole dataset, with the signed-in user's
 * visibility applied — and it gives EPM 47 filters on this instance instead of
 * the six the previous hand-rolled bar could express.
 *
 * Two things are deliberate here:
 *
 *   * Filters are passed through as OpenProject's own JSON rather than being
 *     re-modelled. EPM cannot know what a valid filter is — that depends on the
 *     instance and the project — so the upstream answer is authoritative,
 *     including when it is a rejection.
 *
 *   * Results come back embedded in the query response, so a filtered page of
 *     work packages costs one upstream request rather than two.
 */

const listQuery = z.object({
  projectId: z.string().optional(),
});

const runQuery = z.object({
  projectId: z.string().optional(),
  /** OpenProject filter JSON, forwarded verbatim and validated upstream. */
  filters: z.string().optional(),
  sortBy: z.string().optional(),
  groupBy: z.string().optional(),
  offset: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  showSums: z.coerce.boolean().optional(),
  includeSubprojects: z.coerce.boolean().optional(),
  timestamps: z.string().optional(),
  /** Comma-separated column ids; sent upstream as repeated `columns[]`. */
  columns: z.string().optional(),
});

/** Only these reach OpenProject; anything else a client sends is dropped. */
function upstreamParams(query: z.infer<typeof runQuery>): QueryParams {
  const params: QueryParams = {};
  if (query.filters !== undefined) params.filters = query.filters;
  if (query.sortBy !== undefined) params.sortBy = query.sortBy;
  if (query.groupBy !== undefined) params.groupBy = query.groupBy;
  if (query.offset !== undefined) params.offset = String(query.offset);
  if (query.pageSize !== undefined) params.pageSize = String(query.pageSize);
  if (query.showSums !== undefined) params.showSums = String(query.showSums);
  if (query.includeSubprojects !== undefined) {
    params.includeSubprojects = String(query.includeSubprojects);
  }
  if (query.timestamps !== undefined) params.timestamps = query.timestamps;

  // An empty selection is not "no override" — it would hide every column — so
  // blank entries are dropped and an entirely empty list is ignored.
  if (query.columns !== undefined) {
    const columns = query.columns.split(',').map((id) => id.trim()).filter(Boolean);
    if (columns.length > 0) params.columns = columns;
  }

  return params;
}

/**
 * Translates an upstream failure into an EPM error.
 *
 * OpenProject's query validation is genuinely useful — "Status Operator is not
 * set to one of the allowed values" tells a user exactly what to change — so the
 * message is preserved. Its identifiers, hostname and internals are not.
 */
function asEpmError(error: unknown): EpmError {
  if (error instanceof OpenProjectError) {
    const upstream = error.upstream as { message?: string; errorIdentifier?: string } | undefined;
    const message = upstream?.message ?? error.message;

    if (upstream?.errorIdentifier?.includes('InvalidQuery')) {
      return EpmError.badRequest(message);
    }
    if (error.upstreamStatus === 404) return EpmError.notFound('That view');
    if (error.upstreamStatus === 403) return EpmError.forbidden('You cannot access that view.');
    if (error.upstreamStatus === 422) return EpmError.validation(message);
  }

  return error instanceof EpmError ? error : EpmError.internal('The view could not be loaded.');
}

interface QueryResponse {
  _embedded?: { results?: HalCollection<OpWorkPackage> & { total?: number } };
}

/** A query plus the page of work packages it selects. */
async function runAndNormalize(
  path: string,
  params: QueryParams,
  signal: AbortSignal,
): Promise<{ query: ReturnType<typeof toEpmQuery>; tasks: EpmTask[]; total: number; pageSize: number; page: number }> {
  const response = await openProject.request<QueryResponse & Parameters<typeof toEpmQuery>[0]>(path, {
    query: params,
    signal,
  });

  const results = response._embedded?.results;
  const elements = results?._embedded?.elements ?? [];

  const catalog = await getCatalog(signal);
  const identifiers = new Map<string, string>();

  return {
    query: toEpmQuery(response),
    tasks: elements.map((workPackage) => toEpmTask(workPackage, catalog, identifiers)),
    total: results?.total ?? elements.length,
    pageSize: (results as { pageSize?: number } | undefined)?.pageSize ?? elements.length,
    page: (results as { offset?: number } | undefined)?.offset ?? 1,
  };
}


/**
 * Fills in each filter's display name.
 *
 * The schema collection does not carry titles, and OpenProject exposes no
 * endpoint that lists filters — only `/queries/filters/{id}` one at a time. So
 * a custom field would otherwise read as "Custom Field 1" rather than the name
 * an administrator gave it.
 *
 * Titles are instance configuration and change about as often as statuses do,
 * so the whole set is fetched once and cached. A filter whose title cannot be
 * read keeps the humanised fallback rather than failing the request.
 */
async function applyTitles(
  filters: QueryFilterSchema[],
  scope: string,
  signal: AbortSignal,
): Promise<void> {
  // Keyed by scope: the project-scoped set includes custom fields the global
  // set does not, and a shared key would leave them with the fallback name.
  const titles = await referenceCache.get(`query-filter-titles:${scope}`, async () => {
    const entries = await Promise.all(
      filters.map(async (filter) => {
        const resource = await openProject
          .request<{ _links?: { self?: { title?: string } } }>(
            `/queries/filters/${filter.id}`,
            { signal },
          )
          .catch(() => null);

        return [filter.id, resource?._links?.self?.title] as const;
      }),
    );

    return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));
  });

  for (const filter of filters) {
    const title = (titles as Record<string, string>)[filter.id];
    if (title) filter.name = title;
  }
}


/**
 * Columns a query may display, read from the query creation form.
 *
 * The query schema declares `columns` as writable but sends no allowed values;
 * the form does, and it is project-aware — a custom field appears there under
 * its administrator-given name alongside the built-in attributes. There is no
 * `/queries/columns` collection on this version, so the form is the only
 * authoritative source.
 *
 * Cached with the filter titles: this is instance configuration, not per-request
 * data, and it is scoped by project for the same reason filters are.
 */
async function availableColumns(
  projectId: string | undefined,
  signal: AbortSignal,
): Promise<QueryColumn[]> {
  return referenceCache.get(`query-columns:${projectId ?? 'global'}`, async () => {
    const form = await openProject
      .request<{
        _embedded?: {
          schema?: {
            columns?: { _embedded?: { allowedValues?: { id?: string; name?: string }[] } };
          };
        };
      }>('/queries/form', {
        method: 'POST',
        body: projectId ? { _links: { project: { href: `/api/v3/projects/${projectId}` } } } : {},
        signal,
      })
      .catch(() => null);

    const allowed = form?._embedded?.schema?.columns?._embedded?.allowedValues ?? [];

    return allowed
      .filter((column): column is { id: string; name?: string } => Boolean(column.id))
      .map((column) => ({ id: column.id, name: column.name ?? column.id }));
  }) as Promise<QueryColumn[]>;
}

export const queryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Filters available here, with their operators and value shapes.
   *
   * Project-scoped when a project is given, because custom fields are enabled
   * per project and only appear in that scope — on this instance the global set
   * is 45 filters and project 2 is 47.
   */
  app.get<{ Querystring: unknown }>('/queries/schema', async (request) => {
    const { projectId } = listQuery.parse(request.query);
    const signal = requestSignal(request);

    if (projectId) await guard.require(request, 'task:view', projectId);

    const path = projectId
      ? `/projects/${projectId}/queries/filter_instance_schemas`
      : '/queries/filter_instance_schemas';

    try {
      const collection = await openProject.getAll<Parameters<typeof toFilterSchema>[0]>(
        path,
        { pageSize: 100 },
        { signal },
      );

      const filters = collection.items
        .map(toFilterSchema)
        .filter((schema): schema is QueryFilterSchema => schema !== undefined);

      await applyTitles(filters, projectId ?? 'global', signal);
      filters.sort((a, b) => a.name.localeCompare(b.name));

      const columns = await availableColumns(projectId, signal);

      return { filters, columns };
    } catch (error) {
      throw asEpmError(error);
    }
  });

  /** Saved queries visible to the caller, optionally narrowed to a project. */
  app.get<{ Querystring: unknown }>('/queries', async (request) => {
    const { projectId } = listQuery.parse(request.query);
    const signal = requestSignal(request);

    if (projectId) await guard.require(request, 'task:view', projectId);

    try {
      const collection = await openProject.getAll<Parameters<typeof toEpmQuery>[0]>(
        '/queries',
        projectId
          ? { filters: [{ field: 'project', operator: '=', values: [projectId] }], pageSize: 100 }
          : { pageSize: 100 },
        { signal },
      );

      return collection.items.map(toEpmQuery);
    } catch (error) {
      throw asEpmError(error);
    }
  });

  /**
   * The default view, with overrides applied.
   *
   * This is the ad-hoc path: the client sends filters and paging without
   * anything having been saved, and gets the resulting page back.
   */
  app.get<{ Querystring: unknown }>('/queries/default', async (request) => {
    const parsed = runQuery.parse(request.query);
    const signal = requestSignal(request);

    if (parsed.projectId) await guard.require(request, 'task:view', parsed.projectId);

    const path = parsed.projectId
      ? `/projects/${parsed.projectId}/queries/default`
      : '/queries/default';

    try {
      return await runAndNormalize(path, upstreamParams(parsed), signal);
    } catch (error) {
      throw asEpmError(error);
    }
  });

  /** A saved query, with the same overrides available. */
  app.get<{ Params: { id: string }; Querystring: unknown }>('/queries/:id', async (request) => {
    const parsed = runQuery.parse(request.query);

    try {
      return await runAndNormalize(
        `/queries/${request.params.id}`,
        upstreamParams(parsed),
        requestSignal(request),
      );
    } catch (error) {
      throw asEpmError(error);
    }
  });

  /**
   * Saves a query.
   *
   * Whether the caller may is OpenProject's decision: the payload goes up as
   * given and a refusal comes back as one. There is no capability for creating
   * a query beyond `queries/create`, and it does not cover every case, so
   * asking the upstream is both simpler and more accurate than predicting it.
   */
  app.post<{ Body: { name?: string; projectId?: string; payload?: Record<string, unknown> } }>(
    '/queries',
    async (request, reply) => {
      const { name, projectId, payload } = request.body ?? {};
      if (!name?.trim()) throw EpmError.badRequest('A name is required.');

      if (projectId) await guard.require(request, 'task:view', projectId);

      const body: Record<string, unknown> = {
        ...(payload ?? {}),
        name: name.trim(),
        ...(projectId
          ? { _links: { ...(payload?._links as object), project: { href: `/api/v3/projects/${projectId}` } } }
          : {}),
      };

      try {
        const created = await openProject.request<Parameters<typeof toEpmQuery>[0]>('/queries', {
          method: 'POST',
          body,
          signal: requestSignal(request),
        });

        reply.code(201);
        return toEpmQuery(created);
      } catch (error) {
        throw asEpmError(error);
      }
    },
  );

  /**
   * Updates a saved query.
   *
   * The affordance is checked before writing: OpenProject publishes
   * `updateImmediately` on queries the caller may change, and its absence is
   * the authoritative "no".
   */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/queries/:id',
    async (request) => {
      const { id } = request.params;

      await guard.requireLink(request, `/queries/${id}`, 'updateImmediately', 'change this view');

      try {
        const updated = await openProject.request<Parameters<typeof toEpmQuery>[0]>(
          `/queries/${id}`,
          { method: 'PATCH', body: request.body ?? {}, signal: requestSignal(request) },
        );
        return toEpmQuery(updated);
      } catch (error) {
        throw asEpmError(error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/queries/:id', async (request, reply) => {
    const { id } = request.params;

    await guard.requireLink(request, `/queries/${id}`, 'delete', 'delete this view');

    try {
      await openProject.request<void>(`/queries/${id}`, {
        method: 'DELETE',
        signal: requestSignal(request),
      });
      reply.code(204);
    } catch (error) {
      throw asEpmError(error);
    }
  });

  /**
   * Stars and unstars.
   *
   * OpenProject publishes exactly one of the two affordances depending on the
   * current state, so the relevant one is what gets checked.
   */
  for (const action of ['star', 'unstar'] as const) {
    app.patch<{ Params: { id: string } }>(`/queries/:id/${action}`, async (request) => {
      const { id } = request.params;

      await guard.requireLink(request, `/queries/${id}`, action, `${action} this view`);

      try {
        const updated = await openProject.request<Parameters<typeof toEpmQuery>[0]>(
          `/queries/${id}/${action}`,
          // OpenProject answers 406 to a PATCH with no body here.
          { method: 'PATCH', body: {}, signal: requestSignal(request) },
        );
        return toEpmQuery(updated);
      } catch (error) {
        throw asEpmError(error);
      }
    });
  }
};
