import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { contentDispositionFor, maxUploadBytes } from '../lib/uploads.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import { linkId } from '../openproject/client.js';
import type { HalCollection, HalLink } from '../openproject/types.js';
import { message } from '../lib/i18n.js';

/**
 * Work package attachments.
 *
 * Everything travels through EPM: the browser is never given an OpenProject
 * URL to fetch from, and never a credential to fetch with. Downloads are
 * proxied rather than redirected, which is the only way to keep that true for
 * a file the user can actually open.
 *
 * Two things in OpenProject's own responses are deliberately not passed
 * through, both covered where they are set below: it marks private attachments
 * publicly cacheable, and serves them inline.
 */

interface OpAttachment {
  id: number;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: string;
  description?: { raw?: string };
  digest?: { algorithm?: string; hash?: string };
  _links?: Record<string, HalLink | undefined>;
}

export interface EpmAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: string;
  description?: string;
  authorId?: string;
  /** What this user may do with it, from the affordances OpenProject publishes. */
  can: { delete: boolean };
}

function toEpmAttachment(attachment: OpAttachment): EpmAttachment {
  const links = attachment._links ?? {};

  return {
    id: String(attachment.id),
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    contentType: attachment.contentType,
    createdAt: attachment.createdAt,
    description: attachment.description?.raw || undefined,
    authorId: linkId(links, 'author'),
    can: { delete: Object.hasOwn(links, 'delete') },
  };
}

/** The work package an attachment belongs to, for authorising against its project. */
async function containerOf(
  request: Parameters<typeof requestSignal>[0],
  attachmentId: string,
): Promise<{ attachment: OpAttachment; workPackageId: string }> {
  const attachment = await openProject
    .request<OpAttachment>(`/attachments/${attachmentId}`, { signal: requestSignal(request) })
    .catch(() => null);

  const container = attachment?._links?.container?.href;
  const workPackageId = container?.startsWith('/api/v3/work_packages/')
    ? container.split('/').pop()
    : undefined;

  // An attachment the caller cannot read is reported absent rather than
  // forbidden, so the API does not confirm ids they may not see.
  if (!attachment || !workPackageId) throw EpmError.notFound('That attachment');

  return { attachment, workPackageId };
}

export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  /** Attachments on a work package. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/attachments', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

    const collection = await openProject.getCollection<OpAttachment>(
      `/work_packages/${id}/attachments`,
      { pageSize: 100 },
      requestSignal(request),
    );

    return (collection._embedded?.elements ?? []).map(toEpmAttachment);
  });

  /**
   * Uploads a file.
   *
   * Editing a work package is what OpenProject requires to attach to it, so
   * that is what is checked here; the upstream call would fail anyway, but
   * failing before reading a multi-megabyte body is better than after.
   */
  app.post<{ Params: { id: string } }>('/work-packages/:id/attachments', async (request, reply) => {
    const { id } = request.params;

    await guard.require(request, 'task:edit', await guard.projectOfWorkPackage(request, id));

    const signal = requestSignal(request);
    const limit = await maxUploadBytes(signal);

    // The multipart reader answers a non-multipart body with 406 and its own
    // error code, which tells a client nothing about what to send instead.
    const uploaded = await request
      .file({ limits: { fileSize: limit, files: 1 } })
      .catch(() => {
        throw EpmError.badRequest('Send the file as multipart/form-data.');
      });

    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');

    const buffer = await uploaded.toBuffer();

    // `truncated` is how the multipart reader reports that it stopped at the
    // limit; the partial file must not be forwarded as if it were whole.
    if (uploaded.file.truncated) {
      throw EpmError.badRequest(
        message('That file is larger than the {limit} MB limit.', { limit: Math.floor(limit / 1024 / 1024) }),
      );
    }

    const fileName = uploaded.filename?.trim();
    if (!fileName) throw EpmError.badRequest('The file has no name.');

    const form = new FormData();
    // A plain string field, not a typed part: OpenProject parses this itself,
    // and sending it as a blob makes Rails hand it over as a hash instead.
    form.append('metadata', JSON.stringify({ fileName }));
    // The declared content type is the client's claim, so it is not forwarded
    // as fact; OpenProject sniffs and stores its own, and downloads are served
    // as attachments regardless.
    form.append('file', new Blob([buffer]), fileName);

    const created = await openProject.request<OpAttachment>(
      `/work_packages/${id}/attachments`,
      { method: 'POST', body: form, signal },
    );

    reply.code(201);
    return toEpmAttachment(created);
  });

  /** One attachment's metadata. */
  app.get<{ Params: { id: string } }>('/attachments/:id', async (request) => {
    const { attachment, workPackageId } = await containerOf(request, request.params.id);

    await guard.require(
      request,
      'task:view',
      await guard.projectOfWorkPackage(request, workPackageId),
    );

    return toEpmAttachment(attachment);
  });

  /**
   * Streams the file back.
   *
   * Proxied rather than redirected: handing the browser an OpenProject URL
   * would expose the instance and would not work anyway, since the browser
   * holds no upstream credential.
   */
  app.get<{ Params: { id: string } }>('/attachments/:id/content', async (request, reply) => {
    const { attachment, workPackageId } = await containerOf(request, request.params.id);

    await guard.require(
      request,
      'task:view',
      await guard.projectOfWorkPackage(request, workPackageId),
    );

    const response = await openProject.stream(
      `/attachments/${request.params.id}/content`,
      requestSignal(request),
    );

    if (!response.ok || !response.body) {
      throw EpmError.notFound('That attachment');
    }

    return reply
      .header('Content-Type', attachment.contentType || 'application/octet-stream')
      .header('Content-Disposition', contentDispositionFor(attachment.fileName))
      // OpenProject marks these `public, max-age=21590`. They are private
      // records behind a session, and a shared cache must not keep them.
      .header('Cache-Control', 'private, no-store')
      // The content type is the uploader's claim; stop browsers improving on it.
      .header('X-Content-Type-Options', 'nosniff')
      .send(response.body);
  });

  /** Deletes, if OpenProject says this caller may. */
  app.delete<{ Params: { id: string } }>('/attachments/:id', async (request, reply) => {
    const { id } = request.params;

    // Confirms the attachment is reachable and yields its work package.
    await containerOf(request, id);

    await guard.requireLink(request, `/attachments/${id}`, 'delete', 'delete this attachment');

    await openProject.request<void>(`/attachments/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    reply.code(204);
  });
};

export type { HalCollection };
