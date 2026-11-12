import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { contextConventions, contextLanguage, message, render } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { idFromHref, openProject } from '../openproject/client.js';
import { versionLinks } from '../openproject/versions.js';
import type {
  BoardColumnOption,
  BoardKind,
  EpmBoard,
  EpmBoardColumn,
  EpmBoardSummary,
} from '../types/epm.js';

/**
 * Boards: the delivery system's own, all six kinds, which it keeps as a grid
 * of saved views (one per column) and offers free.
 *
 * A basic board's lists hold whatever is put in them, in the order it is put
 * there. On the other kinds each column stands for one value of an attribute
 * (a status, a person, a version, a sub-project or a parent task), and moving
 * a card into it gives the task that value. Everything goes through API v3 as
 * the signed-in person, so its permissions decide (show_board_views to see a
 * board, manage_board_views to change one) and its own refusals come back.
 *
 * A new board starts with the columns the delivery system's own create
 * services give it: one list on a basic board, the default status on a status
 * board, a column per open version on a version board, and none on the rest.
 */

const KINDS = ['basic', 'status', 'assignee', 'version', 'subproject', 'subtasks'] as const satisfies readonly BoardKind[];

/** The API v3 filter each kind's columns are built on, and what its values are. */
const COLUMN_FILTER: Record<Exclude<BoardKind, 'basic'>, { filter: string; resource: string; link: string }> = {
  status: { filter: 'status', resource: 'statuses', link: 'status' },
  assignee: { filter: 'assignee', resource: 'users', link: 'assignee' },
  version: { filter: 'version', resource: 'versions', link: 'version' },
  subproject: { filter: 'onlySubproject', resource: 'projects', link: 'project' },
  subtasks: { filter: 'parent', resource: 'work_packages', link: 'parent' },
};

/** Cards a column loads at once; the column reports when it holds more. */
const COLUMN_PAGE_SIZE = 200;

/** Gap between the positions written for a column's cards, leaving room to slot one in. */
const POSITION_STEP = 1024;

interface OpWidget {
  id?: number;
  identifier: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  options?: { queryId?: number | string; filters?: unknown[] } & Record<string, unknown>;
}

interface OpGrid {
  id: number;
  name: string;
  rowCount: number;
  columnCount: number;
  options?: { type?: string; attribute?: string } & Record<string, unknown>;
  widgets: OpWidget[];
  _links: Record<string, { href?: string | null } | undefined>;
}

interface OpQuery {
  id: number;
  name: string;
  filters?: { _links?: { filter?: { href?: string }; values?: { href?: string | null }[] } }[];
  _embedded?: { results?: { total?: number; _embedded?: { elements?: WorkPackageWithPoints[] } } };
}

const boardId = z.object({ id: z.string().regex(/^\d+$/) });
const projectParam = z.object({ id: z.string().regex(/^\d+$/) });

/** Turns an upstream refusal into EPM's own error, message intact. */
function rethrow(error: unknown): never {
  if (error instanceof OpenProjectError) {
    if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
    if (error.upstreamStatus === 404) throw EpmError.notFound('That board');
    if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
  }
  throw error;
}

const kindOf = (grid: OpGrid): BoardKind => {
  const attribute = grid.options?.type === 'action' ? grid.options.attribute : undefined;
  return (KINDS as readonly string[]).includes(attribute ?? '') ? (attribute as BoardKind) : 'basic';
};

/** `/projects/<identifier>/boards` → the identifier; anything else is not a board. */
const scopeIdentifier = (grid: OpGrid) => /^\/projects\/([^/]+)\/boards$/.exec(grid._links.scope?.href ?? '')?.[1];

const canManage = (grid: OpGrid) => Boolean(grid._links.update?.href || grid._links.updateImmediately?.href || grid._links.delete?.href);

const columnsOf = (grid: OpGrid) =>
  grid.widgets
    .filter((widget) => widget.identifier === 'work_package_query' && widget.options?.queryId !== undefined)
    .sort((a, b) => a.startColumn - b.startColumn || a.startRow - b.startRow);

/**
 * The names a kind's filter goes by. A version filter is saved as `version`
 * and read back as `targetVersion` where a task may have several versions.
 */
const filterNames = (kind: Exclude<BoardKind, 'basic'>) =>
  kind === 'version' ? ['version', 'targetVersion'] : [COLUMN_FILTER[kind].filter];

/** The value a column's view filters on, read from the view itself. */
function columnValue(kind: BoardKind, query: OpQuery): string | undefined {
  if (kind === 'basic') return undefined;
  const names = filterNames(kind);
  const match = query.filters?.find((one) => names.some((name) => one._links?.filter?.href?.endsWith(`/filters/${name}`)));
  const href = match?._links?.values?.[0]?.href;
  return href ? idFromHref(href) : undefined;
}

/** The values a board's columns stand for already, read from how the grid keeps them. */
function usedValues(kind: BoardKind, grid: OpGrid): Set<string> {
  const used = new Set<string>();
  if (kind === 'basic') return used;
  const names = filterNames(kind);
  for (const widget of columnsOf(grid)) {
    for (const filter of (widget.options?.filters ?? []) as Record<string, { values?: unknown[] }>[]) {
      for (const name of names) {
        const values = filter[name]?.values;
        if (Array.isArray(values) && values[0] !== undefined) used.add(String(values[0]));
      }
    }
  }
  return used;
}

/** A widget as the grid stores a column: its view, and the filter the view applies, in the grid's own shape. */
function widgetFor(kind: BoardKind, queryId: number, column: number, value?: string): OpWidget {
  const filters =
    kind === 'basic'
      ? [{ manualSort: { operator: 'ow', values: [] } }]
      : [{ [COLUMN_FILTER[kind].filter]: { operator: '=', values: [String(value)] } }];
  return {
    identifier: 'work_package_query',
    startRow: 1,
    endRow: 2,
    startColumn: column,
    endColumn: column + 1,
    options: { queryId, filters },
  };
}

/** The columns again, left to right in the given order, with no gaps. */
function packed(widgets: OpWidget[]): OpWidget[] {
  return widgets.map((widget, index) => ({
    ...(widget.id !== undefined ? { id: widget.id } : {}),
    identifier: widget.identifier,
    startRow: 1,
    endRow: 2,
    startColumn: index + 1,
    endColumn: index + 2,
    options: widget.options ?? {},
  }));
}

async function loadGrid(request: FastifyRequest, id: string): Promise<OpGrid & { identifier: string }> {
  const grid = await openProject.request<OpGrid>(`/grids/${id}`, { signal: requestSignal(request) }).catch(rethrow);
  const identifier = scopeIdentifier(grid);
  if (!identifier) throw EpmError.notFound('That board');
  return { ...grid, identifier };
}

async function saveWidgets(request: FastifyRequest, grid: OpGrid, widgets: OpWidget[]) {
  await openProject
    .request(`/grids/${grid.id}`, {
      method: 'PATCH',
      body: { rowCount: 1, columnCount: Math.max(widgets.length, 1), widgets: packed(widgets) },
      signal: requestSignal(request),
    })
    .catch(rethrow);
}

/** A saved view for one column, as the delivery system's own boards make them. */
async function createColumnQuery(
  request: FastifyRequest,
  projectId: string,
  kind: BoardKind,
  name: string,
  value?: string,
): Promise<number> {
  const filter =
    kind === 'basic'
      ? { _links: { filter: { href: '/api/v3/queries/filters/manualSort' }, operator: { href: '/api/v3/queries/operators/ow' } }, values: [] }
      : {
          _links: {
            filter: { href: `/api/v3/queries/filters/${COLUMN_FILTER[kind].filter}` },
            operator: { href: '/api/v3/queries/operators/=' },
            values: [{ href: `/api/v3/${COLUMN_FILTER[kind].resource}/${value}` }],
          },
        };
  const query = await openProject
    .request<{ id: number }>('/queries', {
      method: 'POST',
      once: true,
      body: {
        name,
        public: true,
        showHierarchies: false,
        // A sub-project's work only shows in its parent's views with them included.
        ...(kind === 'subproject' ? { includeSubprojects: true } : {}),
        filters: [filter],
        _links: {
          project: { href: `/api/v3/projects/${projectId}` },
          sortBy: [{ href: '/api/v3/queries/sort_bys/manualSorting-asc' }, { href: '/api/v3/queries/sort_bys/id-asc' }],
        },
      },
      signal: requestSignal(request),
    })
    .catch(rethrow);
  return query.id;
}

async function projectIdOf(request: FastifyRequest, identifier: string): Promise<string> {
  const identifiers = await projectIdentifiers(requestSignal(request));
  const found = [...identifiers.entries()].find(([, value]) => value === identifier)?.[0];
  if (found) return found;
  const project = await openProject.request<{ id: number }>(`/projects/${identifier}`, { signal: requestSignal(request) }).catch(rethrow);
  return String(project.id);
}

function summary(grid: OpGrid, projectId: string): EpmBoardSummary {
  return {
    id: String(grid.id),
    name: grid.name,
    kind: kindOf(grid),
    projectId,
    columnCount: columnsOf(grid).length,
    canManage: canManage(grid),
  };
}

/** The values a new column could stand for, leaving out those already on the board. */
async function columnOptions(
  request: FastifyRequest,
  kind: BoardKind,
  projectId: string,
  used: Set<string>,
  search: string,
): Promise<BoardColumnOption[]> {
  const signal = requestSignal(request);
  const needle = search.trim().toLowerCase();
  const matches = (label: string) => !needle || label.toLowerCase().includes(needle);
  type Named = { id: number; name: string; _links?: Record<string, { href?: string | null; title?: string } | undefined> };
  let options: BoardColumnOption[] = [];
  switch (kind) {
    case 'basic':
      return [];
    case 'status': {
      const statuses = await openProject.getAll<Named & { position?: number }>('/statuses', {}, { signal });
      options = statuses.items
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((status) => ({ value: String(status.id), label: status.name }));
      break;
    }
    case 'assignee': {
      const people = await openProject
        .getAll<Named & { email?: string }>(`/projects/${projectId}/available_assignees`, { pageSize: 200 }, { signal })
        .catch(rethrow);
      options = people.items.map((person) => ({ value: String(person.id), label: person.name, ...(person.email ? { detail: person.email } : {}) }));
      break;
    }
    case 'version': {
      const versions = await openProject
        .getAll<Named & { status?: string; startDate?: string; endDate?: string }>(`/projects/${projectId}/versions`, { pageSize: 200 }, { signal })
        .catch(rethrow);
      options = versions.items
        .filter((version) => version.status !== 'closed')
        .map((version) => ({
          value: String(version.id),
          label: version.name,
          ...(version.startDate || version.endDate ? { detail: [version.startDate, version.endDate].filter(Boolean).join(' – ') } : {}),
        }));
      break;
    }
    case 'subproject': {
      const children = await openProject
        .getAll<Named>('/projects', { filters: [{ field: 'parent_id', operator: '=', values: [projectId] }], pageSize: 200 }, { signal })
        .catch(rethrow);
      options = children.items.map((child) => ({ value: String(child.id), label: child.name }));
      break;
    }
    case 'subtasks': {
      const work = await openProject
        .getCollection<{ id: number; subject: string; displayId?: string }>(
          '/work_packages',
          {
            filters: [
              { field: 'project', operator: '=', values: [projectId] },
              ...(needle ? [{ field: 'subjectOrId', operator: '**' as const, values: [search.trim()] }] : []),
            ],
            sortBy: [['id', 'asc']],
            pageSize: 50,
          },
          signal,
        )
        .catch(rethrow);
      // The key as EPM shows it everywhere (mapping/tasks.ts).
      const identifiers = await projectIdentifiers(signal);
      const identifier = identifiers.get(projectId);
      const keyOf = (id: number) => (identifier ? `${identifier.slice(0, 6).toUpperCase()}-${id}` : `WP-${id}`);
      return (work._embedded?.elements ?? [])
        .filter((item) => !used.has(String(item.id)))
        .map((item) => ({ value: String(item.id), label: item.subject, detail: keyOf(item.id) }));
    }
  }
  return options.filter((option) => !used.has(option.value) && matches(option.label)).slice(0, 100);
}

export const boardRoutes: FastifyPluginAsync = async (app) => {
  /** A project's boards. */
  app.get('/projects/:id/boards', async (request): Promise<EpmBoardSummary[]> => {
    const { id } = projectParam.parse(request.params);
    await guard.require(request, 'task:view', id);
    const signal = requestSignal(request);
    const project = await openProject.request<{ identifier: string }>(`/projects/${id}`, { signal }).catch(rethrow);
    const grids = await openProject
      .getAll<OpGrid>('/grids', { filters: [{ field: 'scope', operator: '=', values: [`/projects/${project.identifier}/boards`] }], pageSize: 100 }, { signal })
      .catch(rethrow);
    return grids.items.map((grid) => summary(grid, id)).sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Makes a board, with the columns the delivery system's own would start with. */
  app.post<{ Body: unknown }>('/projects/:id/boards', async (request, reply): Promise<EpmBoardSummary> => {
    const { id } = projectParam.parse(request.params);
    const body = z.object({ name: z.string().trim().min(1, 'A name is required.').max(255), kind: z.enum(KINDS) }).parse(request.body ?? {});
    await guard.require(request, 'task:view', id);
    const signal = requestSignal(request);
    const project = await openProject.request<{ identifier: string }>(`/projects/${id}`, { signal }).catch(rethrow);

    const columns: { name: string; value?: string }[] = [];
    if (body.kind === 'basic') {
      columns.push({ name: render(contextLanguage(), message('Unnamed list'), contextConventions()) });
    } else if (body.kind === 'status') {
      const statuses = await openProject.getAll<{ id: number; name: string; isDefault?: boolean }>('/statuses', {}, { signal });
      const initial = statuses.items.find((status) => status.isDefault) ?? statuses.items[0];
      if (initial) columns.push({ name: initial.name, value: String(initial.id) });
    } else if (body.kind === 'version') {
      const versions = await openProject
        .getAll<{ id: number; name: string; status?: string; _links?: Record<string, { href?: string | null } | undefined> }>(`/projects/${id}/versions`, { pageSize: 200 }, { signal })
        .catch(rethrow);
      for (const version of versions.items) {
        const defining = idFromHref(version._links?.definingProject?.href ?? '');
        if (version.status === 'open' && defining === id) columns.push({ name: version.name, value: String(version.id) });
      }
    }

    const widgets: OpWidget[] = [];
    for (const [index, column] of columns.entries()) {
      const queryId = await createColumnQuery(request, id, body.kind, column.name, column.value);
      widgets.push(widgetFor(body.kind, queryId, index + 1, column.value));
    }
    const grid = await openProject
      .request<OpGrid>('/grids', {
        method: 'POST',
        once: true,
        body: {
          name: body.name,
          rowCount: 1,
          columnCount: Math.max(widgets.length, 4),
          options: body.kind === 'basic' ? { type: 'free', highlightingMode: 'priority' } : { type: 'action', attribute: body.kind, highlightingMode: 'priority' },
          widgets,
          _links: { scope: { href: `/projects/${project.identifier}/boards` } },
        },
        signal,
      })
      .catch(async (error) => {
        // The columns' views were made for a board that now will not exist.
        await Promise.all(widgets.map((widget) => openProject.request(`/queries/${widget.options?.queryId}`, { method: 'DELETE' }).catch(() => undefined)));
        rethrow(error);
      });
    reply.code(201);
    return summary(grid, id);
  });

  /** A board with its columns and the cards in each, in their order. */
  app.get('/boards/:id', async (request): Promise<EpmBoard> => {
    const { id } = boardId.parse(request.params);
    const signal = requestSignal(request);
    const grid = await loadGrid(request, id);
    const projectId = await projectIdOf(request, grid.identifier);
    await guard.require(request, 'task:view', projectId);
    const kind = kindOf(grid);
    const [catalog, identifiers] = await Promise.all([getCatalog(signal), projectIdentifiers(signal)]);
    const columns = await Promise.all(
      columnsOf(grid).map(async (widget): Promise<EpmBoardColumn | null> => {
        const query = await openProject
          .request<OpQuery>(`/queries/${widget.options!.queryId}`, { query: { pageSize: COLUMN_PAGE_SIZE, offset: 1 }, signal })
          .catch((error) => {
            // A column whose view went missing or cannot be read is left out
            // rather than failing the whole board.
            if (error instanceof OpenProjectError && (error.upstreamStatus === 404 || error.upstreamStatus === 403)) return null;
            throw error;
          });
        if (!query) return null;
        const value = columnValue(kind, query);
        const results = query._embedded?.results;
        return {
          queryId: String(query.id),
          name: query.name,
          ...(value ? { value } : {}),
          cards: (results?._embedded?.elements ?? []).map((item) => toEpmTask(item, catalog, identifiers)),
          total: results?.total ?? 0,
        };
      }),
    );
    return { ...summary(grid, projectId), columns: columns.filter((column): column is EpmBoardColumn => column !== null) };
  });

  app.patch<{ Body: unknown }>('/boards/:id', async (request): Promise<EpmBoardSummary> => {
    const { id } = boardId.parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1, 'A name is required.').max(255) }).parse(request.body ?? {});
    const grid = await loadGrid(request, id);
    const updated = await openProject
      .request<OpGrid>(`/grids/${id}`, { method: 'PATCH', body: { name }, signal: requestSignal(request) })
      .catch(rethrow);
    return summary(updated, await projectIdOf(request, grid.identifier));
  });

  /** Deletes a board; the delivery system removes its columns' views with it. */
  app.delete('/boards/:id', async (request, reply) => {
    const { id } = boardId.parse(request.params);
    await loadGrid(request, id);
    await openProject.request(`/grids/${id}`, { method: 'DELETE', signal: requestSignal(request) }).catch(rethrow);
    reply.code(204);
  });

  /** What a new column could stand for, by kind; searched by name (or a task's subject). */
  app.get<{ Querystring: { search?: string } }>('/boards/:id/column-options', async (request): Promise<BoardColumnOption[]> => {
    const { id } = boardId.parse(request.params);
    const grid = await loadGrid(request, id);
    const projectId = await projectIdOf(request, grid.identifier);
    const kind = kindOf(grid);
    return columnOptions(request, kind, projectId, usedValues(kind, grid), String(request.query.search ?? '').slice(0, 100));
  });

  /** Adds a column at the right-hand end: a named list on a basic board, a value on the others. */
  app.post<{ Body: unknown }>('/boards/:id/columns', async (request, reply) => {
    const { id } = boardId.parse(request.params);
    const body = z
      .object({ name: z.string().trim().max(255).optional(), value: z.string().regex(/^\d+$/).optional() })
      .parse(request.body ?? {});
    const grid = await loadGrid(request, id);
    const projectId = await projectIdOf(request, grid.identifier);
    const kind = kindOf(grid);
    let name = body.name;
    if (kind === 'basic') {
      if (!name) throw EpmError.badRequest('A name is required.');
    } else {
      if (!body.value) throw EpmError.badRequest('Choose what the column stands for.');
      if (usedValues(kind, grid).has(body.value)) throw EpmError.conflict('That column is on the board already.');
      const options = await columnOptions(request, kind, projectId, new Set(), '');
      const chosen = kind === 'subtasks' ? undefined : options.find((option) => option.value === body.value);
      if (kind !== 'subtasks' && !chosen) throw EpmError.badRequest('That cannot be a column on this board.');
      if (kind === 'subtasks') {
        const parent = await openProject
          .request<{ subject: string }>(`/work_packages/${body.value}`, { signal: requestSignal(request) })
          .catch(rethrow);
        name = parent.subject;
      } else {
        name = chosen!.label;
      }
    }
    const queryId = await createColumnQuery(request, projectId, kind, name!, body.value);
    const columns = columnsOf(grid);
    try {
      await saveWidgets(request, grid, [...columns, widgetFor(kind, queryId, columns.length + 1, body.value)]);
    } catch (error) {
      await openProject.request(`/queries/${queryId}`, { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
    reply.code(201);
    return { queryId: String(queryId), name };
  });

  /** Removes a column and its view. The tasks in it are not touched. */
  app.delete('/boards/:id/columns/:queryId', async (request, reply) => {
    const { id, queryId } = z.object({ id: z.string().regex(/^\d+$/), queryId: z.string().regex(/^\d+$/) }).parse(request.params);
    const grid = await loadGrid(request, id);
    const columns = columnsOf(grid);
    if (!columns.some((widget) => String(widget.options?.queryId) === queryId)) throw EpmError.notFound('That column');
    await saveWidgets(request, grid, columns.filter((widget) => String(widget.options?.queryId) !== queryId));
    await openProject.request(`/queries/${queryId}`, { method: 'DELETE', signal: requestSignal(request) }).catch(() => undefined);
    reply.code(204);
  });

  /** Puts the columns in the given order. */
  app.put<{ Body: unknown }>('/boards/:id/columns/order', async (request) => {
    const { id } = boardId.parse(request.params);
    const { queryIds } = z.object({ queryIds: z.array(z.string().regex(/^\d+$/)).max(100) }).parse(request.body ?? {});
    const grid = await loadGrid(request, id);
    const columns = columnsOf(grid);
    const byQuery = new Map(columns.map((widget) => [String(widget.options?.queryId), widget]));
    if (queryIds.length !== columns.length || queryIds.some((queryId) => !byQuery.has(queryId))) {
      throw EpmError.badRequest('Name every column of the board once.');
    }
    await saveWidgets(request, grid, queryIds.map((queryId) => byQuery.get(queryId)!));
    return { ok: true };
  });

  /**
   * Moves a card: into another column (giving the task that column's value,
   * except on a basic board), and to its place in the column. A task not yet
   * on a basic board's list is added to it this way.
   */
  app.post<{ Body: unknown }>('/boards/:id/move', async (request) => {
    const { id } = boardId.parse(request.params);
    const body = z
      .object({
        workPackageId: z.string().regex(/^\d+$/),
        fromQueryId: z.string().regex(/^\d+$/).optional(),
        toQueryId: z.string().regex(/^\d+$/),
        position: z.number().int().min(0).max(100_000),
      })
      .parse(request.body ?? {});
    const signal = requestSignal(request);
    const grid = await loadGrid(request, id);
    const kind = kindOf(grid);
    const queryIds = new Set(columnsOf(grid).map((widget) => String(widget.options?.queryId)));
    if (!queryIds.has(body.toQueryId) || (body.fromQueryId && !queryIds.has(body.fromQueryId))) {
      throw EpmError.badRequest('That column is not on this board.');
    }
    const target = await openProject
      .request<OpQuery>(`/queries/${body.toQueryId}`, { query: { pageSize: COLUMN_PAGE_SIZE, offset: 1 }, signal })
      .catch(rethrow);

    // Into another column of an action board: the task takes the column's value.
    if (kind !== 'basic' && body.fromQueryId !== body.toQueryId) {
      const value = columnValue(kind, target);
      if (!value) throw EpmError.badRequest('That column stands for nothing a task can take.');
      if (kind === 'subtasks' && value === body.workPackageId) throw EpmError.validation('A task cannot be its own parent.');
      const current = await openProject
        .request<{ lockVersion: number }>(`/work_packages/${body.workPackageId}`, { signal })
        .catch(rethrow);
      await openProject
        .request(`/work_packages/${body.workPackageId}`, {
          method: 'PATCH',
          body: {
            lockVersion: current.lockVersion,
            // A version goes through both of its names: with several versions
            // allowed, a write to `version` alone is ignored.
            _links:
              kind === 'version'
                ? versionLinks(value)
                : { [COLUMN_FILTER[kind].link]: { href: `/api/v3/${COLUMN_FILTER[kind].resource}/${value}` } },
          },
          signal,
        })
        .catch(rethrow);
    }

    // Its place in the column: every card's position, written again in steps.
    const order = (target._embedded?.results?._embedded?.elements ?? [])
      .map((item) => String(item.id))
      .filter((cardId) => cardId !== body.workPackageId);
    order.splice(Math.min(body.position, order.length), 0, body.workPackageId);
    const delta = Object.fromEntries(order.map((cardId, index) => [cardId, (index + 1) * POSITION_STEP]));
    await openProject.request(`/queries/${body.toQueryId}/order`, { method: 'PATCH', body: { delta }, signal }).catch(rethrow);
    if (body.fromQueryId && body.fromQueryId !== body.toQueryId) {
      await openProject
        .request(`/queries/${body.fromQueryId}/order`, { method: 'PATCH', body: { delta: { [body.workPackageId]: -1 } }, signal })
        .catch(() => undefined);
    }
    return { ok: true };
  });

  /** Takes a card off a basic board's list. The task itself is not touched. */
  app.delete('/boards/:id/columns/:queryId/cards/:workPackageId', async (request, reply) => {
    const { id, queryId, workPackageId } = z
      .object({ id: z.string().regex(/^\d+$/), queryId: z.string().regex(/^\d+$/), workPackageId: z.string().regex(/^\d+$/) })
      .parse(request.params);
    const grid = await loadGrid(request, id);
    if (kindOf(grid) !== 'basic') throw EpmError.badRequest('Only a basic board’s lists hold cards by hand.');
    if (!columnsOf(grid).some((widget) => String(widget.options?.queryId) === queryId)) throw EpmError.notFound('That column');
    await openProject
      .request(`/queries/${queryId}/order`, { method: 'PATCH', body: { delta: { [workPackageId]: -1 } }, signal: requestSignal(request) })
      .catch(rethrow);
    reply.code(204);
  });
};

/**
 * The saved views boards and dashboards use for their columns and widgets.
 * They are part of those, not views anyone saved, so lists of saved views
 * leave them out.
 */
export async function widgetQueryIds(signal?: AbortSignal): Promise<Set<string>> {
  const grids = await openProject.getAll<OpGrid>('/grids', { pageSize: 200 }, { signal, maxPages: 10 }).catch(() => ({ items: [] as OpGrid[] }));
  const ids = new Set<string>();
  for (const grid of grids.items) {
    for (const widget of grid.widgets ?? []) {
      const queryId = widget.options?.queryId;
      if (queryId !== undefined && queryId !== null) ids.add(String(queryId));
    }
  }
  return ids;
}
