import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { notifyCommentAdded } from '../domain/collaboration-notifications.js';
import { EpmError } from '../lib/errors.js';
import { getUsers } from '../mapping/users.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';

/**
 * Comments on a work package.
 *
 * OpenProject has no comment resource. A comment is a journal activity that
 * happens to carry text, sharing a collection with the entries that record
 * field changes, so listing comments means filtering a journal rather than
 * reading a collection of comments.
 *
 * Three consequences shape this file.
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
 * And the rendered `html` upstream returns is not passed on. It is real markup
 * — an `<img>` survives sanitisation — and putting it in EPM's origin would
 * mean trusting another system's sanitiser with this one's DOM. Clients get the
 * markdown source and render it as text.
 */

interface OpActivity {
  id: number;
  _type?: string;
  comment?: { format?: string; raw?: string; html?: string };
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

function toEpmComment(activity: OpActivity, names: Map<string, string>): EpmComment {
  const links = activity._links ?? {};
  const authorId = href(links.user)?.split('/').pop() ?? '';

  return {
    id: String(activity.id),
    author: { id: authorId, name: names.get(authorId) ?? 'Unknown user' },
    body: activity.comment?.raw ?? '',
    createdAt: activity.createdAt,
    // Equal timestamps mean it was never edited, and saying so would put an
    // "edited" note on every comment.
    updatedAt:
      activity.updatedAt && activity.updatedAt !== activity.createdAt
        ? activity.updatedAt
        : undefined,
    editable: Object.hasOwn(links, 'update'),
    deletable: Object.hasOwn(links, 'delete'),
  };
}

/** Author display names, from the cached user directory rather than per comment. */
async function authorNames(signal: AbortSignal): Promise<Map<string, string>> {
  const users = await getUsers(signal).catch(() => []);
  return new Map(users.map((user) => [user.id, user.name]));
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

    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

    // Walked to completion because upstream ignores pageSize and offset: the
    // journal arrives whole or not at all, so paging is the client's to do.
    const [{ items }, names] = await Promise.all([
      openProject.getAll<OpActivity>(`/work_packages/${id}/activities`, { pageSize: 100 }, { signal }),
      authorNames(signal),
    ]);

    return items.filter(isComment).map((activity) => toEpmComment(activity, names));
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

      const names = await authorNames(signal);
      const comment = toEpmComment(created, names);

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

  /** Edits a comment, if OpenProject offers that on the record. */
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

      await guard.requireLink(request, `/activities/${commentId}`, 'update', 'edit this comment');

      const signal = requestSignal(request);

      const updated = await openProject.request<OpActivity>(`/activities/${commentId}`, {
        method: 'PATCH',
        // A bare string. The nested form used on create is rejected here.
        body: { comment: body },
        signal,
      });

      return toEpmComment(updated, await authorNames(signal));
    },
  );
};
