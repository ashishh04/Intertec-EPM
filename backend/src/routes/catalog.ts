import type { FastifyPluginAsync } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import type { OpPriority, OpStatus, OpType } from '../openproject/types.js';

/**
 * OpenProject reference data, passed through unreduced.
 *
 * The EPM domain models collapse statuses, types and priorities into fixed
 * unions so the UI can style them consistently. That collapse is lossy: this
 * instance has 14 statuses behind 6 EPM values. Anything that lets a user
 * *choose* a value — a status dropdown, a type picker, a filter — has to offer
 * the real set, or the UI silently cannot express what OpenProject allows.
 *
 * These routes are the escape hatch: the true catalogue, ids included, for
 * pickers and writes. Read paths keep using the normalized models.
 */

export interface CatalogValue {
  id: string;
  name: string;
  /** Present when OpenProject exposes ordering. */
  position?: number;
}

export interface StatusValue extends CatalogValue {
  isClosed: boolean;
  isDefault?: boolean;
}

export interface TypeValue extends CatalogValue {
  isMilestone: boolean;
  isDefault?: boolean;
  color?: string;
}

export interface PriorityValue extends CatalogValue {
  isDefault?: boolean;
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  /** Every status the instance defines, in OpenProject's own order. */
  app.get('/catalog/statuses', async (request) => {
    const { items } = await openProject.getAll<OpStatus & { position?: number; isDefault?: boolean }>(
      '/statuses',
      { pageSize: 100 },
      { signal: requestSignal(request) },
    );

    return items
      .map<StatusValue>((status) => ({
        id: String(status.id),
        name: status.name,
        isClosed: Boolean(status.isClosed),
        isDefault: status.isDefault,
        position: status.position,
      }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  });

  app.get('/catalog/types', async (request) => {
    const { items } = await openProject.getAll<
      OpType & { position?: number; isDefault?: boolean; color?: string }
    >('/types', { pageSize: 100 }, { signal: requestSignal(request) });

    return items
      .map<TypeValue>((type) => ({
        id: String(type.id),
        name: type.name,
        isMilestone: Boolean(type.isMilestone),
        isDefault: type.isDefault,
        color: type.color,
        position: type.position,
      }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  });

  /**
   * Resolves a schema's `allowedValues` link.
   *
   * Some schema fields embed their options and some publish a link to fetch
   * them — `assignee`, `responsible` and a project's `parent` are all the
   * second kind. Without this the form had nothing to offer for those fields
   * and fell back to a text box, which rendered the current value as
   * `[object Object]`.
   *
   * The href is one the schema itself supplied, so the browser is echoing
   * server data rather than knowing the shape of an upstream URL. It is still
   * validated here: only an absolute `/api/v3/` path, no traversal, because a
   * caller-supplied path reaching the upstream client is exactly the thing to
   * be careful with.
   */
  app.get<{ Querystring: { href?: string } }>('/catalog/allowed-values', async (request) => {
    const href = String(request.query.href ?? '');

    if (!href.startsWith('/api/v3/') || href.includes('..')) {
      throw EpmError.badRequest('That is not a value list this form can offer.');
    }

    const collection = await openProject.request<{
      _embedded?: { elements?: { id?: unknown; name?: string; value?: string; _links?: { self?: { href?: string } } }[] };
    }>(href.slice('/api/v3'.length), { signal: requestSignal(request) });

    return (collection._embedded?.elements ?? [])
      .map((element) => {
        const selfHref = element._links?.self?.href;
        const id = element.id !== undefined ? String(element.id) : undefined;
        // A custom option calls its label `value`; everything else `name`.
        const name = element.name ?? element.value;
        return selfHref && name ? { id: id ?? selfHref, name, href: selfHref } : undefined;
      })
      .filter((value): value is { id: string; name: string; href: string } => Boolean(value));
  });

  app.get('/catalog/priorities', async (request) => {
    const { items } = await openProject.getAll<
      OpPriority & { position?: number; isDefault?: boolean }
    >('/priorities', { pageSize: 100 }, { signal: requestSignal(request) });

    return items
      .map<PriorityValue>((priority) => ({
        id: String(priority.id),
        name: priority.name,
        isDefault: priority.isDefault,
        position: priority.position,
      }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  });

  /**
   * Types enabled for one project. A project only permits a subset, and
   * offering the instance-wide list produces 422s on create.
   */
  app.get<{ Params: { id: string } }>('/catalog/projects/:id/types', async (request) => {
    const collection = await openProject.getCollection<
      OpType & { position?: number; color?: string }
    >(`/projects/${request.params.id}/types`, { pageSize: 100 }, requestSignal(request));

    return collection._embedded.elements.map<TypeValue>((type) => ({
      id: String(type.id),
      name: type.name,
      isMilestone: Boolean(type.isMilestone),
      color: type.color,
      position: type.position,
    }));
  });

  /** Versions (EPM sprints) available in a project, for the version picker. */
  app.get<{ Params: { id: string } }>('/catalog/projects/:id/versions', async (request) => {
    const collection = await openProject.getCollection<{
      id: number;
      name: string;
      status?: string;
    }>(`/projects/${request.params.id}/versions`, { pageSize: 100 }, requestSignal(request));

    return collection._embedded.elements.map((version) => ({
      id: String(version.id),
      name: version.name,
      status: version.status,
    }));
  });

  /** Categories are a per-project work package field with no EPM equivalent. */
  app.get<{ Params: { id: string } }>('/catalog/projects/:id/categories', async (request) => {
    const collection = await openProject.getCollection<{ id: number; name: string }>(
      `/projects/${request.params.id}/categories`,
      { pageSize: 100 },
      requestSignal(request),
    );

    return collection._embedded.elements.map((category) => ({
      id: String(category.id),
      name: category.name,
    }));
  });

  /** Who may be assigned within a project — membership-aware, unlike /users. */
  app.get<{ Params: { id: string } }>('/catalog/projects/:id/assignees', async (request) => {
    const collection = await openProject.getCollection<{
      id: number;
      name: string;
      _links?: Record<string, { href?: string }>;
    }>(`/projects/${request.params.id}/available_assignees`, { pageSize: 200 }, requestSignal(request));

    return collection._embedded.elements.map((user) => ({
      id: String(user.id),
      name: user.name,
    }));
  });

  /** Roles, for the membership editor. */
  app.get('/catalog/roles', async (request) => {
    const { items } = await openProject.getAll<{ id: number; name: string }>(
      '/roles',
      { pageSize: 100 },
      { signal: requestSignal(request) },
    );
    return items.map((role) => ({ id: String(role.id), name: role.name }));
  });
};

export { linkId };
