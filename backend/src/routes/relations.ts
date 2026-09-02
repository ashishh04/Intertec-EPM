import type { FastifyPluginAsync } from 'fastify';

import { anywhere } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, type OpFilter } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';

/**
 * Relations between work packages.
 *
 * Two things about OpenProject's model drive everything below.
 *
 * First, a relation is stored one way round. `from --blocks--> to` is the only
 * record; there is no second row saying `to is blocked by from`. Asking a work
 * package for "its" relations returns rows where it is sometimes the `from` and
 * sometimes the `to`, and rendering `type` blindly would report exactly half of
 * them backwards. Normalization to the asking work package's point of view
 * happens once, here, so React only ever receives "this task <label> that one".
 *
 * Second, OpenProject canonicalizes on write. Posting `precedes` stores
 * `follows` with `from` and `to` swapped. That is relied on rather than worked
 * around: sending the reverse alias is how you create a relation in the reverse
 * direction, and upstream does the swap.
 *
 * Endpoint note: `/work_packages/:id/relations` is a 308 redirect to the
 * filtered collection used below. The redirect is not followed, because the
 * `Location` it returns carries the request's credentials.
 */

interface OpRelation {
  id: number;
  name?: string;
  type: string;
  reverseType?: string;
  lag?: number | null;
  description?: string | null;
  _links?: Record<string, HalLink | undefined>;
}

/**
 * The relation vocabulary of OpenProject 15.5.1.
 *
 * Verified against the running instance by attempting every candidate: these
 * six pairs are accepted, `parent` is accepted but returns no `reverseType` and
 * does not alter the work package's `parent` link, so hierarchy is left to the
 * mechanism that actually owns it.
 *
 * There is no upstream source for this table. `/relations/schema`,
 * `/relations/:id/schema`, `/relations/form` and
 * `/work_packages/:id/relations/form` are all 404, and a relation's `name` only
 * ever describes its canonical direction. The forward labels below are the
 * `name` values upstream returns; the reverse labels are EPM's, because nothing
 * upstream states them.
 */
const RELATION_TYPES = [
  { type: 'relates', label: 'related to', reverseType: 'relates', reverseLabel: 'related to' },
  {
    type: 'duplicates',
    label: 'duplicates',
    reverseType: 'duplicated',
    reverseLabel: 'duplicated by',
  },
  { type: 'blocks', label: 'blocks', reverseType: 'blocked', reverseLabel: 'blocked by' },
  { type: 'follows', label: 'follows', reverseType: 'precedes', reverseLabel: 'precedes' },
  { type: 'includes', label: 'includes', reverseType: 'partof', reverseLabel: 'part of' },
  { type: 'requires', label: 'requires', reverseType: 'required', reverseLabel: 'required by' },
] as const;

/** Every direction a user may pick, forward and reverse flattened into one list. */
export interface EpmRelationType {
  /** What to send when creating. Reverse directions are aliases upstream accepts. */
  value: string;
  label: string;
}

const SELECTABLE_TYPES: EpmRelationType[] = RELATION_TYPES.flatMap((pair) =>
  pair.type === pair.reverseType
    ? [{ value: pair.type, label: pair.label }]
    : [
        { value: pair.type, label: pair.label },
        { value: pair.reverseType, label: pair.reverseLabel },
      ],
);

/** Label for a direction, whichever side of a pair it names. */
const LABELS = new Map<string, string>(SELECTABLE_TYPES.map((type) => [type.value, type.label]));

export interface EpmRelation {
  id: string;
  /**
   * The relation as the asking work package sees it. For a stored
   * `A --blocks--> B`, this is `blocks` when A asked and `blocked` when B did.
   */
  type: string;
  label: string;
  /** The work package at the other end. Never the one that was asked about. */
  related: { id: string; subject: string };
  /** Days of lag, on scheduling relations that carry it. */
  lag?: number;
  description?: string;
  can: { delete: boolean; update: boolean };
}

/**
 * Rewrites a stored relation into the asking work package's point of view.
 *
 * `context` is the work package whose relations were requested. If it is the
 * `from` side the relation already reads correctly; if it is the `to` side both
 * the type and the endpoint have to be flipped.
 */
function toEpmRelation(relation: OpRelation, context: string): EpmRelation | null {
  const links = relation._links ?? {};
  const from = links.from?.href;
  const to = links.to?.href;

  if (!from || !to) return null;

  const fromId = from.split('/').pop();
  const toId = to.split('/').pop();
  const contextIsFrom = fromId === context;

  const other = contextIsFrom
    ? { id: toId, title: links.to?.title }
    : { id: fromId, title: links.from?.title };

  if (!other.id) return null;

  const type = contextIsFrom ? relation.type : (relation.reverseType ?? relation.type);

  return {
    id: String(relation.id),
    type,
    // Upstream's `name` describes the canonical direction only, so it is used
    // for that direction and EPM's own label for the other.
    label: (contextIsFrom ? relation.name : undefined) ?? LABELS.get(type) ?? type,
    related: { id: other.id, subject: other.title ?? `Work package ${other.id}` },
    lag: relation.lag ?? undefined,
    description: relation.description || undefined,
    can: {
      delete: Object.hasOwn(links, 'delete'),
      update: Object.hasOwn(links, 'updateImmediately'),
    },
  };
}

export const relationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The directions a relation may be created in.
   *
   * A static vocabulary rather than instance data, so the question is only
   * whether the caller works with work packages at all. Asked as "anywhere"
   * deliberately: `task:view` is granted per project, and a user who holds it
   * in one project holds no global grant to check against.
   */
  app.get('/relation-types', async (request) => {
    if (!anywhere(await guard.permissionsFor(request), 'task:view')) {
      throw EpmError.forbidden('You do not have permission to view work packages.');
    }

    return SELECTABLE_TYPES;
  });

  /** A work package's relations, each stated from its point of view. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/relations', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

    const collection = await openProject.getCollection<OpRelation>(
      '/relations',
      { filters: [{ field: 'involved', operator: '=', values: [id] }], pageSize: 100 },
      requestSignal(request),
    );

    return (collection._embedded?.elements ?? [])
      .map((relation) => toEpmRelation(relation, id))
      .filter((relation): relation is EpmRelation => relation !== null);
  });

  /**
   * Work packages this one could be related to.
   *
   * Searched upstream rather than listed: a project's work packages can run to
   * thousands, and loading them all to filter in the browser would be slow and
   * would hand the client far more than it asked for.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/work-packages/:id/relatable',
    async (request) => {
      const { id } = request.params;
      const term = request.query.q?.trim();

      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

      const collection = await openProject.getCollection<{ id: number; subject: string }>(
        '/work_packages',
        {
          filters: [
            // Excludes itself: a work package cannot be related to itself, and
            // upstream rejects it as a circular dependency.
            { field: 'id', operator: '!', values: [id] },
            ...(term ? [{ field: 'search', operator: '**', values: [term] } as OpFilter] : []),
          ],
          sortBy: [['updatedAt', 'desc']],
          pageSize: 20,
        },
        requestSignal(request),
      );

      return (collection._embedded?.elements ?? []).map((workPackage) => ({
        id: String(workPackage.id),
        subject: workPackage.subject,
      }));
    },
  );

  /** Creates a relation. */
  app.post<{
    Params: { id: string };
    Body: { type?: string; relatedId?: string; description?: string; lag?: number };
  }>('/work-packages/:id/relations', async (request, reply) => {
    const { id } = request.params;
    const { type, relatedId, description, lag } = request.body ?? {};

    if (!type || !relatedId) throw EpmError.badRequest('A type and relatedId are required.');

    // Checked against the verified vocabulary so an unknown value fails here
    // with a usable message rather than as an upstream validation error.
    if (!LABELS.has(type)) throw EpmError.badRequest(`${type} is not a relation type.`);

    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));
    await guard.requireLink(
      request,
      `/work_packages/${id}`,
      'addRelation',
      'add relations to this work package',
    );

    // Sent as chosen, including reverse aliases. OpenProject stores the
    // canonical form and swaps the endpoints, which is the intended meaning.
    const created = await openProject.request<OpRelation>(`/work_packages/${id}/relations`, {
      method: 'POST',
      body: {
        _links: { to: { href: `/api/v3/work_packages/${relatedId}` } },
        type,
        ...(description ? { description } : {}),
        ...(lag !== undefined ? { lag } : {}),
      },
      signal: requestSignal(request),
    });

    reply.code(201);
    // Normalized back to the caller's point of view, so a reverse alias reads
    // the way it was asked for rather than the way it was stored.
    return toEpmRelation(created, id);
  });

  /** Deletes a relation, if OpenProject offers that on the record. */
  app.delete<{ Params: { id: string } }>('/relations/:id', async (request, reply) => {
    const { id } = request.params;

    await guard.requireLink(request, `/relations/${id}`, 'delete', 'delete this relation');

    await openProject.request<void>(`/relations/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    reply.code(204);
  });
};
