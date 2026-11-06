import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { runAsSystem } from '../auth/context.js';
import * as guard from '../auth/guard.js';
import { notifyCommentAdded } from '../domain/collaboration-notifications.js';
import { referenceCache } from '../lib/cache.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { getUsers } from '../mapping/users.js';
import { requestSignal } from '../lib/request-signal.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { HalLink, OpMembership } from '../openproject/types.js';

/**
 * Comments on a work package.
 *
 * OpenProject has no comment resource. A comment is a journal activity that
 * happens to carry text, sharing a collection with the entries that record
 * field changes, so listing comments means filtering a journal rather than
 * reading a collection of comments.
 *
 * Four consequences shape this file.
 *
 * Creating and editing take different payloads upstream — `{comment:{raw}}` to
 * create, `{comment: "…"}` to edit, and using either shape on the other call
 * fails. Both are built here so a client never sees the difference.
 *
 * Deletion does not exist. No `delete` affordance is published on any activity
 * and the verb is refused, so no delete route is offered. `deletable` is still
 * reported, read from the affordance like every other capability, so it becomes
 * true on its own if upstream ever grows one.
 *
 * Editing is the exception to reading affordances: an activity's `update` link
 * is not the reader's. See `CommentRights` below for why, and what is read
 * instead.
 *
 * And the rendered `html` upstream returns is not passed on. It is real markup
 * — an `<img>` survives sanitisation — and putting it in EPM's origin would
 * mean trusting another system's sanitiser with this one's DOM. Clients get the
 * markdown source and render it as text.
 */

interface OpActivity {
  id: number;
  _type?: string;
  comment?: { format?: string; raw?: string; html?: string };
  /** An internal comment, which its own pair of permissions governs. */
  internal?: boolean;
  /** The fields this journal entry changed, as sentences. */
  details?: unknown[];
  createdAt: string;
  updatedAt?: string;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
}

export interface EpmComment {
  id: string;
  author: { id: string; name: string };
  /** Markdown source. Never upstream's rendered html — see the note above. */
  body: string;
  createdAt: string;
  /** Present only when the comment has been edited since it was written. */
  updatedAt?: string;
  editable: boolean;
  deletable: boolean;
}

/**
 * Whether an activity is a comment rather than a record of field changes.
 *
 * `_type` is the primary signal, but it is derived from content upstream: a
 * comment edited down to whitespace comes back as a plain `Activity`. Text is
 * therefore accepted as evidence too, so an entry with something to say is
 * never dropped because of how it was typed.
 */
function isComment(activity: OpActivity): boolean {
  return activity._type === 'Activity::Comment' || (activity.comment?.raw ?? '').trim().length > 0;
}

function href(link: HalLink | HalLink[] | undefined): string | undefined {
  return (Array.isArray(link) ? link[0]?.href : link?.href) ?? undefined;
}

/** Who wrote an activity: the id at the end of its `user` link. */
function authorOf(activity: OpActivity): string {
  return href(activity._links?.user)?.split('/').pop() ?? '';
}

function toEpmComment(activity: OpActivity, names: Map<string, string>, editable: boolean): EpmComment {
  const links = activity._links ?? {};
  const authorId = authorOf(activity);

  /*
   * When it was written, which is not always the entry's `createdAt`.
   *
   * OpenProject folds what one person does within a few minutes into one journal
   * entry, so a comment written soon after an edit lands in the edit's entry: it
   * keeps the edit's `createdAt`, and `updatedAt` is the moment of the comment. It
   * read "7 minutes ago · edited 15 seconds ago" on a comment just posted and never
   * edited. An entry that also changed fields is such a one; its `updatedAt` is the
   * time to show, and no edit can be told from it.
   */
  const folded = (activity.details?.length ?? 0) > 0 && Boolean(activity.updatedAt);

  return {
    id: String(activity.id),
    author: { id: authorId, name: names.get(authorId) ?? 'Unknown user' },
    body: activity.comment?.raw ?? '',
    createdAt: folded ? activity.updatedAt! : activity.createdAt,
    // Equal timestamps mean it was never edited, and saying so would put an
    // "edited" note on every comment.
    updatedAt:
      !folded && activity.updatedAt && activity.updatedAt !== activity.createdAt
        ? activity.updatedAt
        : undefined,
    editable,
    deletable: Object.hasOwn(links, 'delete'),
  };
}

/**
 * What a person may do to the comments of one project, in OpenProject's own
 * terms.
 *
 * Not read from a comment's `update` link, though OpenProject publishes one,
 * because that link is not the reader's. OpenProject caches each comment's JSON
 * per comment and language, links included — its activity representer is a
 * cached one, and `update` is neither `cache_if` nor `uncacheable` there — so
 * whoever is first shown a comment after it changes, usually its author in the
 * reply to posting or editing it, decides the link for every reader after them.
 * Someone who may not edit was offered the edit (and refused it), and someone
 * who may could be shown none.
 *
 * So OpenProject's rule is applied to the reader instead
 * (`WorkPackage#journal_editable_by?`): "Moderate comments" edits anyone's,
 * "Edit own comments" one's own, and internal comments follow their own pair of
 * permissions the same way. An administrator holds them all. The permissions
 * are those of the person's roles in the project, read with the system key —
 * API v3 publishes no capability for any of the four. Access that comes only
 * from a share of the work package, or from a public project's non-member
 * role, is not counted: such a person is never offered more than they hold, at
 * worst less. The edit itself stays OpenProject's to allow or refuse.
 */
interface CommentRights {
  /** An administrator: every permission, everywhere. */
  all: boolean;
  /** OpenProject's names for the permissions held in the project. */
  names: ReadonlySet<string>;
}

/** How long a person's rights, the roles and the administrators are reused: as long as their EPM permissions are. */
const RIGHTS_TTL_MS = 60_000;

/** Every role's permissions, which API v3 does not publish; the admin add-on does. */
function rolePermissions(): Promise<Map<string, ReadonlySet<string>>> {
  return referenceCache.get(
    'comment-role-permissions',
    async () => {
      const roles = await runAsSystem(() =>
        openProject.request<{ id: number | string; permissions?: string[] }[]>('/epm_admin/roles', { root: true }),
      );
      return new Map(roles.map((role) => [String(role.id), new Set(role.permissions ?? [])]));
    },
    RIGHTS_TTL_MS,
  );
}

/** The instance's administrators. From the add-on: API v3 shows the flag only to administrators, and the system key need not be one. */
function administratorIds(): Promise<ReadonlySet<string>> {
  return referenceCache.get(
    'comment-administrators',
    async () => {
      const { ids } = await runAsSystem(() =>
        openProject.request<{ ids: string[] }>('/epm_admin/users/administrators', { root: true }),
      );
      return new Set(ids.map(String));
    },
    RIGHTS_TTL_MS,
  );
}

function commentRights(projectId: string, userId: string): Promise<CommentRights> {
  return referenceCache.get(
    `comment-rights:${projectId}:${userId}`,
    async () => {
      const [administrators, roles, memberships] = await Promise.all([
        administratorIds(),
        rolePermissions(),
        // A group's roles reach its members through memberships of their own,
        // so filtering on the person finds those too.
        runAsSystem(() =>
          openProject.getAll<OpMembership>('/memberships', {
            filters: [
              { field: 'project', operator: '=', values: [projectId] },
              { field: 'principal', operator: '=', values: [userId] },
            ],
            pageSize: 20,
          }),
        ),
      ]);

      const names = new Set<string>();
      for (const membership of memberships.items) {
        const links = membership._links?.roles;
        for (const role of Array.isArray(links) ? links : links ? [links] : []) {
          for (const name of roles.get(idFromHref(role.href) ?? '') ?? []) names.add(name);
        }
      }
      return { all: administrators.has(userId), names };
    },
    RIGHTS_TTL_MS,
  );
}

/** Whether these rights edit this comment; none known, none offered. */
function mayEdit(rights: CommentRights | null, activity: OpActivity, userId: string): boolean {
  if (!rights) return false;
  if (rights.all) return true;

  const own = userId !== '' && authorOf(activity) === userId;
  return activity.internal
    ? rights.names.has('edit_others_internal_comments') || (own && rights.names.has('edit_own_internal_comments'))
    : rights.names.has('edit_work_package_comments') || (own && rights.names.has('edit_own_work_package_comments'));
}

/** Author display names, from the cached user directory rather than per comment. */
async function authorNames(signal: AbortSignal): Promise<Map<string, string>> {
  const users = await getUsers(signal).catch(() => []);
  return new Map(users.map((user) => [user.id, user.name]));
}

/**
 * The caller's comment rights in a project, or null when they could not be
 * read: that offers no edit, and fails nothing else.
 */
function callerRights(request: FastifyRequest, projectId: string): Promise<CommentRights | null> {
  return commentRights(projectId, request.auth?.userId ?? '').catch((error: unknown) => {
    request.log.warn({ err: error, projectId }, 'Comment rights could not be read; no comment is offered for editing');
    return null;
  });
}

/**
 * The same, found from the work package, for the reply to a write: the comment
 * is saved by then, so nothing here may turn that into an error.
 */
function callerRightsOn(request: FastifyRequest, workPackageId: string): Promise<CommentRights | null> {
  return guard
    .projectOfWorkPackage(request, workPackageId)
    .then((projectId) => callerRights(request, projectId))
    .catch(() => null);
}

/** The activity, with the work package it belongs to, for authorising an edit. */
async function activityOf(
  request: Parameters<typeof requestSignal>[0],
  commentId: string,
): Promise<{ activity: OpActivity; workPackageId: string }> {
  const activity = await openProject
    .request<OpActivity>(`/activities/${commentId}`, { signal: requestSignal(request) })
    .catch(() => null);

  const workPackageId = href(activity?._links?.workPackage)?.split('/').pop();

  // Reported absent rather than forbidden, so the API does not confirm the
  // existence of comments the caller may not read.
  if (!activity || !workPackageId) throw EpmError.notFound('That comment');

  return { activity, workPackageId };
}

export const commentRoutes: FastifyPluginAsync = async (app) => {
  /** Comments on a work package, oldest first. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/comments', async (request) => {
    const { id } = request.params;
    const signal = requestSignal(request);
    const projectId = await guard.projectOfWorkPackage(request, id);

    await guard.require(request, 'task:view', projectId);

    // Walked to completion because upstream ignores pageSize and offset: the
    // journal arrives whole or not at all, so paging is the client's to do.
    const [{ items }, names, rights] = await Promise.all([
      openProject.getAll<OpActivity>(`/work_packages/${id}/activities`, { pageSize: 100 }, { signal }),
      authorNames(signal),
      callerRights(request, projectId),
    ]);

    const userId = request.auth?.userId ?? '';
    return items.filter(isComment).map((activity) => toEpmComment(activity, names, mayEdit(rights, activity, userId)));
  });

  /** Adds a comment. */
  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/work-packages/:id/comments',
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body?.body?.trim();

      if (!body) throw EpmError.badRequest('A comment cannot be empty.');

      // Commenting has no capability of its own; the work package advertises it.
      await guard.requireLink(
        request,
        `/work_packages/${id}`,
        'addComment',
        'comment on this work package',
      );

      const signal = requestSignal(request);

      const created = await openProject.request<OpActivity>(`/work_packages/${id}/activities`, {
        method: 'POST',
        // The nested form. Editing takes a bare string instead.
        body: { comment: { raw: body } },
        signal,
      });

      const [names, rights] = await Promise.all([authorNames(signal), callerRightsOn(request, id)]);
      const comment = toEpmComment(created, names, mayEdit(rights, created, request.auth?.userId ?? ''));

      /*
       * Tell the people involved, and whoever was named.
       *
       * Not awaited. The comment is saved and the writer should see it land; a
       * fan-out over the watcher list must not sit between them and the reply,
       * and a mail failure must not turn a saved comment into an error.
       */
      void notifyCommentAdded({
        workPackageId: id,
        commentId: comment.id,
        body,
        authorId: request.auth?.userId ?? '',
        authorName: comment.author.name,
      });

      reply.code(201);
      return comment;
    },
  );

  /** Edits a comment, if OpenProject allows the caller to. */
  app.patch<{ Params: { id: string; commentId: string }; Body: { body?: string } }>(
    '/work-packages/:id/comments/:commentId',
    async (request) => {
      const { id, commentId } = request.params;
      const body = request.body?.body?.trim();

      if (!body) throw EpmError.badRequest('A comment cannot be empty.');

      const { workPackageId } = await activityOf(request, commentId);

      // The comment has to belong to the work package in the path, or one work
      // package's route could be used to edit another's comments.
      if (workPackageId !== id) throw EpmError.notFound('That comment');

      const signal = requestSignal(request);

      // Not checked first against the comment's `update` link: that link may be
      // someone else's (see `CommentRights`), which let the wrong people through
      // to the refusal below and could turn away the right ones. OpenProject
      // decides the edit on the caller's own token; a refusal is the person's,
      // not a fault upstream, and is worded as every other refusal here is.
      const updated = await openProject
        .request<OpActivity>(`/activities/${commentId}`, {
          method: 'PATCH',
          // A bare string. The nested form used on create is rejected here.
          body: { comment: body },
          signal,
        })
        .catch((error: unknown) => {
          if (error instanceof OpenProjectError && error.upstreamStatus === 403) {
            throw EpmError.forbidden(message('You do not have permission to {action}.', { action: 'edit this comment' }));
          }
          throw error;
        });

      const [names, rights] = await Promise.all([authorNames(signal), callerRightsOn(request, id)]);
      return toEpmComment(updated, names, mayEdit(rights, updated, request.auth?.userId ?? ''));
    },
  );
};
