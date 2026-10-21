import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, type QueryParams } from '../openproject/client.js';
import { referenceCache, userScopedKey } from '../lib/cache.js';
import { getCatalog } from '../mapping/catalog.js';
import { toEpmTask } from '../mapping/tasks.js';
import {
  toEpmQuery,
  toFilterSchema,
  toTaskGroups,
  type QueryColumn,
  type QueryFilterSchema,
  type TaskGroup,
} from '../mapping/queries.js';
import type { HalCollection, OpWorkPackage } from '../openproject/types.js';
import type { EpmTask } from '../types/epm.js';
import { message } from '../lib/i18n.js';

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

/**
 * A boolean from a query string.
 *
 * Not `z.coerce.boolean()`, which is `Boolean(value)` and so answers `true` for
 * every non-empty string — including `"false"`. That turned "group these rows
 * and do not draw the hierarchy" into "group them and draw it too", and
 * OpenProject refused the pair with "Display mode is mutually exclusive with
 * group by 'project'".
 */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

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
  showSums: booleanish.optional(),
  /**
   * Return the rows as a tree rather than a flat list: each top-level item
   * followed by its children, theirs, and so on — all of them at once, the
   * table paging the rows it shows. OpenProject's API does not do
   * this — it accepts the flag and returns the rows in sort order, its own
   * screen building the tree in the browser — so EPM does (see `treePage`).
   */
  showHierarchies: booleanish.optional(),
  includeSubprojects: booleanish.optional(),
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

  /*
   * The tree is EPM's to build (`runAndNormalize`), so the flag is kept here as
   * the caller's wish and never sent upstream as true: OpenProject's API only
   * accepts it, and refuses it outright beside a grouping — "Display mode is
   * mutually exclusive with group by 'project'".
   */
  if (query.showHierarchies !== undefined) params.showHierarchies = String(query.showHierarchies);
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
    if (error.upstreamStatus === 403) {
      // Two different refusals wear the same status. MissingPermission means the
      // caller holds the permission in no project at all — on an instance with
      // no projects in it, that is every view, and "you cannot access that view"
      // describes a permissions problem the reader does not have. The other 403
      // is the real one: a view belonging to someone else.
      return upstream?.errorIdentifier?.endsWith(':MissingPermission')
        ? EpmError.forbidden('There are no projects to show here yet.')
        : EpmError.forbidden('You cannot access that view.');
    }
    if (error.upstreamStatus === 422) return EpmError.validation(message);
  }

  return error instanceof EpmError ? error : EpmError.internal('The view could not be loaded.');
}

interface QueryResponse {
  _embedded?: {
    results?: HalCollection<OpWorkPackage> & {
      total?: number;
      /** Present when sums are asked for: the whole result set's, per summable column. */
      totalSums?: Record<string, unknown>;
      /** Present only when the query groups; summarises the whole result set. */
      groups?: { value?: unknown; count?: number }[];
    };
  };
}

/** Rows read for a tree, at most: the whole result is needed to order it. */
const TREE_LIMIT = 5000;
const TREE_READ = 1000;

export interface TaskTree {
  /** Rows matching the query, in every top-level item, not only this page's. */
  rows: number;
  /** How deep each row on the page is: 0 for a top-level item. */
  depth: Record<string, number>;
  /** How many children each row on the page has. */
  children: Record<string, number>;
  /** Rows whose parent the query does not select (filtered out): shown at the top level. */
  parentOutside: string[];
  /** More rows matched than a tree is built from; the rest are not shown. */
  truncated: boolean;
}

/** Groupings a tree can sit inside: a work package's children share its project. */
const TREE_GROUPINGS = new Set(['project']);

/**
 * One page of a tree: the page's top-level items, each followed depth-first by
 * its descendants, siblings in the query's own order. A row whose parent is not
 * in the list (filtered out, or in another group) stands at the top level, so
 * nothing is hidden. Grouped, each group holds its own trees, in the groups'
 * order, and a page is so many top-level items across them; each group's
 * `taskIds` become the page's rows in it, its count staying the whole result's.
 */
export function treePage(
  tasks: EpmTask[],
  page: number,
  size: number,
  groups?: TaskGroup[],
): { rows: EpmTask[]; roots: number; groups?: TaskGroup[]; tree: Omit<TaskTree, 'rows' | 'truncated'> } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const sets = groups ? groups.map((group) => group.taskIds.map((id) => byId.get(id)).filter((task): task is EpmTask => Boolean(task))) : [tasks];
  const groupOf = new Map<string, number>();
  const children = new Map<string, EpmTask[]>();
  const roots: { task: EpmTask; group: number }[] = [];
  sets.forEach((set, group) => {
    for (const task of set) groupOf.set(task.id, group);
    for (const task of set) {
      if (task.parentId && groupOf.get(task.parentId) === group) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
      else roots.push({ task, group });
    }
  });
  const rows: EpmTask[] = [];
  const idsByGroup = sets.map((): string[] => []);
  const depth: Record<string, number> = {};
  const childCount: Record<string, number> = {};
  const seen = new Set<string>();
  const visit = (task: EpmTask, level: number, group: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push(task);
    idsByGroup[group]!.push(task.id);
    depth[task.id] = level;
    const below = children.get(task.id) ?? [];
    childCount[task.id] = below.length;
    for (const child of below) visit(child, level + 1, group);
  };
  for (const { task, group } of roots.slice((page - 1) * size, page * size)) visit(task, 0, group);
  return {
    rows,
    roots: roots.length,
    ...(groups ? { groups: groups.map((group, index) => ({ ...group, taskIds: idsByGroup[index]! })) } : {}),
    tree: {
      depth,
      children: childCount,
      parentOutside: rows.filter((task) => task.parentId && groupOf.get(task.parentId) !== groupOf.get(task.id)).map((task) => task.id),
    },
  };
}

/** A query plus the page of work packages it selects. */
async function runAndNormalize(
  path: string,
  params: QueryParams,
  signal: AbortSignal,
): Promise<{
  query: ReturnType<typeof toEpmQuery>;
  tasks: EpmTask[];
  /** Present only when grouping; absent rather than empty when not. */
  groups?: TaskGroup[];
  /** Present only when sums were asked for: per column id, over the whole result. */
  sums?: Record<string, number | string>;
  total: number;
  pageSize: number;
  page: number;
  /** Present only as a tree: then every row comes at once, and `total` counts top-level items. */
  tree?: TaskTree;
}> {
  // A tree is built from the whole result, read a large page at a time; ungrouped, or grouped by project.
  const asTree = params.showHierarchies === 'true' && (!params.groupBy || TREE_GROUPINGS.has(String(params.groupBy)));
  const upstream: QueryParams = asTree
    ? { ...params, offset: '1', pageSize: String(TREE_READ), showHierarchies: 'false' }
    : { ...params, ...(params.showHierarchies ? { showHierarchies: 'false' } : {}) };
  let response: QueryResponse & Parameters<typeof toEpmQuery>[0];
  try {
    response = await openProject.request<QueryResponse & Parameters<typeof toEpmQuery>[0]>(path, {
      query: upstream,
      signal,
    });
  } catch (error) {
    /*
     * An instance with no projects in it refuses every view, because the caller
     * holds `view_work_packages` nowhere — so the page that lists work showed a
     * failure card on a product that was merely empty.
     *
     * The view definition cannot be recovered here: it arrives embedded in the
     * response that just failed. An empty one stands in, which `toEpmQuery`
     * builds from nothing, and the page renders the same "Default view, no
     * filters, no columns" chrome it would for a view that selects nothing. The
     * list below it is then empty rather than broken, which is the truth.
     *
     * Only MissingPermission. A 403 on a view belonging to someone else is a
     * real refusal and still surfaces as one.
     */
    if (
      error instanceof OpenProjectError &&
      error.upstreamStatus === 403 &&
      error.upstreamIdentifier?.endsWith(':MissingPermission')
    ) {
      return {
        query: toEpmQuery({} as Parameters<typeof toEpmQuery>[0]),
        tasks: [],
        total: 0,
        pageSize: Number(params.pageSize ?? 0) || 25,
        page: 1,
      };
    }
    throw error;
  }

  // A saved view's own grouping, when the request names none, may be one a tree cannot sit in: then a plain page.
  const viewGrouping = toEpmQuery(response).groupBy;
  if (asTree && !params.groupBy && viewGrouping && !TREE_GROUPINGS.has(viewGrouping)) {
    return runAndNormalize(path, { ...params, showHierarchies: 'false' }, signal);
  }

  const results = response._embedded?.results;
  let elements = results?._embedded?.elements ?? [];
  const matched = results?.total ?? elements.length;
  if (asTree) {
    for (let offset = 2; elements.length < Math.min(matched, TREE_LIMIT); offset += 1) {
      const more = await openProject.request<QueryResponse>(path, { query: { ...upstream, offset: String(offset) }, signal });
      const page = more._embedded?.results?._embedded?.elements ?? [];
      if (page.length === 0) break;
      elements = [...elements, ...page];
    }
    elements = elements.slice(0, TREE_LIMIT);
  }

  const catalog = await getCatalog(signal);
  const identifiers = new Map<string, string>();

  const query = toEpmQuery(response);

  // Groups only mean something alongside the field they were built from.
  const rawGroups = results?.groups;
  const groups =
    rawGroups && query.groupBy
      ? toTaskGroups(
          rawGroups,
          elements as unknown as Record<string, unknown>[],
          query.groupBy,
        )
      : undefined;

  // Sums cover the whole result, not the page. Durations stay ISO 8601 and
  // money stays as upstream formats it; empty sums are dropped.
  const sums = results?.totalSums
    ? Object.fromEntries(
        Object.entries(results.totalSums).filter(
          (entry): entry is [string, number | string] => typeof entry[1] === 'number' || (typeof entry[1] === 'string' && entry[1] !== ''),
        ),
      )
    : undefined;

  if (asTree) {
    // The whole tree at once: the table pages the rows that can be seen, as branches are folded and unfolded.
    const { rows, roots, tree, groups: pageGroups } = treePage(
      elements.map((workPackage) => toEpmTask(workPackage, catalog, identifiers)),
      1,
      Number.MAX_SAFE_INTEGER,
      groups,
    );
    return {
      query,
      tasks: rows,
      ...(pageGroups ? { groups: pageGroups } : {}),
      ...(sums ? { sums } : {}),
      total: roots,
      pageSize: rows.length,
      page: 1,
      tree: { ...tree, rows: Math.min(matched, TREE_LIMIT), truncated: matched > TREE_LIMIT },
    };
  }

  return {
    query,
    tasks: elements.map((workPackage) => toEpmTask(workPackage, catalog, identifiers)),
    ...(groups ? { groups } : {}),
    ...(sums ? { sums } : {}),
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
/** In flight per scope, so a burst of requests warms the titles once. */
const titleWarmups = new Set<string>();

/**
 * How many title lookups run at once.
 *
 * There is no collection endpoint for filters — `/queries/filters` is a 404, and
 * each title lives in its own resource — so this is genuinely one request per
 * filter. Six at a time keeps the warm-up from saturating an OpenProject that is
 * serving real requests at the same time.
 */
const TITLE_CONCURRENCY = 6;

/**
 * Upgrades filter names from the instance's own labels, without blocking on it.
 *
 * This used to fetch all of them and wait: 47 filters on project 2, one request
 * each, against an OpenProject running two Puma workers — 21 seconds, over the
 * browser's 20-second timeout. The request then failed, so the cache was never
 * populated, so the *next* attempt did exactly the same thing. The Tasks tab
 * could not be opened at all.
 *
 * What the titles actually buy is the administrator's name for a custom field —
 * "Sprint points" instead of "Custom field 3". Everything else already humanises
 * correctly from its id. That is worth having and is not worth a page load, so:
 * cached titles are applied immediately, and when there are none the schema goes
 * out with humanised names while the real ones are fetched in the background.
 * The next open has them.
 */
async function applyTitles(
  filters: QueryFilterSchema[],
  scope: string,
  _signal: AbortSignal,
): Promise<void> {
  // Keyed by scope: the project-scoped set includes custom fields the global
  // set does not, and a shared key would leave them with the fallback name.
  const key = userScopedKey(`query-filter-titles:${scope}`);
  const cached = referenceCache.peek<Record<string, string>>(key);

  if (cached) {
    for (const filter of filters) {
      const title = cached[filter.id];
      if (title) filter.name = title;
    }
    return;
  }

  if (titleWarmups.has(key)) return;
  titleWarmups.add(key);

  /*
   * Deliberately not awaited, and deliberately without the request's signal:
   * the request is about to finish and aborting its signal would cancel the
   * warm-up with it, leaving the cache empty and the next request in exactly
   * the same position.
   */
  void (async () => {
    try {
      const ids = filters.map((filter) => filter.id);
      const titles: Record<string, string> = {};

      for (let at = 0; at < ids.length; at += TITLE_CONCURRENCY) {
        const batch = ids.slice(at, at + TITLE_CONCURRENCY);
        const resolved = await Promise.all(
          batch.map(async (id) => {
            const resource = await openProject
              .request<{ _links?: { self?: { title?: string } } }>(`/queries/filters/${id}`)
              .catch(() => null);
            return [id, resource?._links?.self?.title] as const;
          }),
        );

        for (const [id, title] of resolved) if (title) titles[id] = title;
      }

      referenceCache.set(key, titles);
    } finally {
      titleWarmups.delete(key);
    }
  })();
}


/**
 * What a query may display and sort by, read from the query creation form.
 *
 * The query schema declares `columns` and `sortBy` writable but sends no
 * allowed values; the form does, and it is project-aware, so a custom field
 * appears in both under its administrator-given name. There is no
 * `/queries/columns` or `/queries/sort_bys` collection on this version.
 *
 * Sortability is reported separately from the column list because the two are
 * genuinely different questions. This instance can render spent time but not
 * sort by it, and can sort by category and duration without EPM having anywhere
 * to show them — conflating the two would get both wrong.
 *
 * Cached alongside the filter titles: instance configuration, scoped by project
 * for the same reason filters are.
 */
async function queryCapabilities(
  projectId: string | undefined,
  signal: AbortSignal,
): Promise<{ columns: QueryColumn[]; sortable: string[]; groupable: QueryColumn[] }> {
  return referenceCache.get(userScopedKey(`query-capabilities:${projectId ?? 'global'}`), async () => {
    const form = await openProject
      .request<{
        _embedded?: {
          schema?: {
            columns?: { _embedded?: { allowedValues?: { id?: string; name?: string }[] } };
            sortBy?: {
              _embedded?: { allowedValues?: { _links?: { column?: { href?: string } } }[] };
            };
            groupBy?: { _embedded?: { allowedValues?: { id?: string; name?: string }[] } };
          };
        };
      }>('/queries/form', {
        method: 'POST',
        body: projectId ? { _links: { project: { href: `/api/v3/projects/${projectId}` } } } : {},
        signal,
      })
      .catch(() => null);

    const schema = form?._embedded?.schema;

    const columns = (schema?.columns?._embedded?.allowedValues ?? [])
      .filter((column): column is { id: string; name?: string } => Boolean(column.id))
      .map((column) => ({ id: column.id, name: column.name ?? column.id }));

    // Each entry is one direction of one column ("id-asc", "id-desc"), so the
    // column link is the distinct field rather than the entry id.
    const sortable = [
      ...new Set(
        (schema?.sortBy?._embedded?.allowedValues ?? [])
          .map((entry) => entry._links?.column?.href?.split('/').pop())
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    // Grouping is offered for a much narrower set than columns or sorting, and
    // carries its own titles — including a custom field's configured name.
    const groupable = (schema?.groupBy?._embedded?.allowedValues ?? [])
      .filter((option): option is { id: string; name?: string } => Boolean(option.id))
      .map((option) => ({ id: option.id, name: option.name ?? option.id }));

    return { columns, sortable, groupable };
  }) as Promise<{ columns: QueryColumn[]; sortable: string[]; groupable: QueryColumn[] }>;
}


/**
 * A saved view, described in EPM's terms.
 *
 * The browser sends column names, a grouping and filters; the HAL links are
 * built here. That keeps the shape of the upstream API out of the bundle — the
 * client used to construct `/api/v3/queries/columns/...` itself, which is the
 * one thing the browser is never supposed to know.
 */
interface QueryView {
  columns?: unknown;
  groupBy?: unknown;
  /** Sort criteria, upstream's `attribute-direction` form, e.g. `subject-desc`. */
  sort?: unknown;
  /**
   * `{ id, operator, values }`, each value a record as `{ id }` or `{ href }`,
   * or a literal — a number, a date, text — as `{ value }`.
   */
  filters?: unknown;
  /** Show the sum of each summable column under the table. */
  sums?: unknown;
}

/**
 * Attribute names, so they are safe to put in a path segment.
 *
 * Hyphens are allowed because a sort criterion carries its direction that way.
 * No slashes, dots or encoded characters — this is the whole reason the client
 * no longer builds these URLs itself.
 */
const ATTRIBUTE = /^[A-Za-z0-9_-]+$/;

function attribute(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!ATTRIBUTE.test(text)) throw EpmError.badRequest(message('That {field} is not valid.', { field: what }));
  return text;
}

function toQueryPayload(view: QueryView): Record<string, unknown> {
  const columns = Array.isArray(view.columns) ? view.columns : [];
  const filters = Array.isArray(view.filters) ? view.filters : [];

  const groupBy =
    view.groupBy === null || view.groupBy === undefined || view.groupBy === ''
      ? { href: null }
      : { href: `/api/v3/queries/group_bys/${attribute(view.groupBy, 'grouping')}` };

  const sort = Array.isArray(view.sort) ? view.sort : [];

  return {
    ...(view.sums === undefined ? {} : { sums: view.sums === true }),
    _links: {
      columns: columns.map((column) => ({
        href: `/api/v3/queries/columns/${attribute(column, 'column')}`,
      })),
      groupBy,
      ...(sort.length > 0
        ? {
            sortBy: sort.map((criterion) => ({
              href: `/api/v3/queries/sort_bys/${attribute(criterion, 'sort')}`,
            })),
          }
        : {}),
    },
    filters: filters.map((entry) => {
      const filter = (entry ?? {}) as { id?: unknown; operator?: unknown; values?: unknown };
      const operator = typeof filter.operator === 'string' ? filter.operator : '';
      if (!operator) throw EpmError.badRequest('A filter needs an operator.');
      const given = Array.isArray(filter.values) ? filter.values : [];
      const isLiteral = (value: unknown): value is { value: unknown } =>
        typeof value === 'object' && value !== null && 'value' in value;
      const literals = given.filter(isLiteral).map((value) => String(value.value));
      const records = given.filter((value) => !isLiteral(value));

      return {
        _links: {
          filter: { href: `/api/v3/queries/filters/${attribute(filter.id, 'filter')}` },
          // Operators are symbols such as `=`, `!` and `>t-`, so they are
          // encoded rather than pattern-matched.
          operator: { href: `/api/v3/queries/operators/${encodeURIComponent(operator)}` },
          // Values are passed through, not built. They point at whatever the
          // filter is about — a status, a person, a type — so there is no one
          // collection to construct a link into. A client sends back the href
          // the schema gave it, which is echoing server data rather than
          // knowing the upstream URL shape. Absent for literals: upstream
          // reads links first, and an empty list of them would blank the
          // literal values below.
          ...(literals.length > 0 && records.length === 0
            ? {}
            : {
                values: records.map((value) => {
                  const entry = (value ?? {}) as { href?: unknown; id?: unknown };
                  const href = typeof entry.href === 'string' ? entry.href : String(entry.id ?? value);
                  if (href.includes('..')) throw EpmError.badRequest('That filter value is not valid.');
                  return { href };
                }),
              }),
        },
        // A number, a date or some text is not a record and has no link:
        // upstream takes it as itself, and refuses it as a link ("Total float
        // (days) is not an integer"). The client says which it is, as the
        // schema told it (`isResource`), by sending `{ value }`.
        ...(literals.length > 0 ? { values: literals } : {}),
      };
    }),
  };
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

      const { columns, sortable, groupable } = await queryCapabilities(projectId, signal);

      return { filters, columns, sortable, groupable };
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
  app.post<{ Body: { name?: string; projectId?: string; view?: QueryView } }>(
    '/queries',
    async (request, reply) => {
      const { name, projectId, view } = request.body ?? {};
      if (!name?.trim()) throw EpmError.badRequest('A name is required.');

      if (projectId) await guard.require(request, 'task:view', projectId);

      const payload = toQueryPayload(view ?? {});

      const body: Record<string, unknown> = {
        ...payload,
        name: name.trim(),
        ...(projectId
          ? {
              _links: {
                ...(payload._links as object),
                project: { href: `/api/v3/projects/${projectId}` },
              },
            }
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

      await guard.requireLink(request, `/queries/${id}`, action, action === 'star' ? 'star this view' : 'unstar this view');

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
