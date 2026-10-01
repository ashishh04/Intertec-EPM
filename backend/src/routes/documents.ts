import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { contentDispositionFor, maxUploadBytes } from '../lib/uploads.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import { notifyDocumentUploaded } from '../domain/collaboration-notifications.js';
import { optional, prisma } from '../db/prisma.js';
import type { OpAttachment } from '../openproject/types.js';
import type { DocumentKind, EpmDocument } from '../types/epm.js';

/**
 * The document library is backed by OpenProject attachments. Kind and share
 * state have no upstream equivalent and come from the EPM overlay.
 */

const EXTENSION_KIND: Record<string, DocumentKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  txt: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  odp: 'slide',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  zip: 'archive',
  gz: 'archive',
  tar: 'archive',
  '7z': 'archive',
  rar: 'archive',
  md: 'markdown',
  markdown: 'markdown',
};

function kindOf(fileName: string, contentType: string): DocumentKind {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (EXTENSION_KIND[extension]) return EXTENSION_KIND[extension] as DocumentKind;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.includes('pdf')) return 'pdf';
  return 'doc';
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The document library.
   *
   * Driven by EPM's own overlay rows, not by an upstream listing: OpenProject
   * has no attachment collection — `GET /api/v3/attachments` is a 404 — so the
   * previous implementation asked for one, swallowed the failure and returned
   * an empty array every time. The library appeared to work and had never
   * listed a single file.
   *
   * EPM records what it stores, so the overlay is the index and OpenProject is
   * asked only for the metadata of rows that exist. A file removed upstream
   * drops out rather than appearing as a broken entry.
   *
   * Deliberately not the same thing as a work package's attachments: those
   * belong to their work package and are listed there.
   */
  app.get('/documents', async (request) => {
    const { projectId, search } = z
      .object({ projectId: z.string().optional(), search: z.string().optional() })
      .parse(request.query);

    const signal = requestSignal(request);

    // Filtered in the database where it can be, so the fan-out below is over
    // the rows that can actually match.
    const needle = search?.trim().toLowerCase();
    const overlays = await optional(
      () =>
        prisma.documentMeta.findMany({
          where: projectId ? { projectId } : {},
          orderBy: { createdAt: 'desc' },
          // A bound rather than a page: the library is small, and an unbounded
          // walk here would be one upstream request per row.
          take: 500,
        }),
      [],
    );

    const documents = await Promise.all(
      overlays.map(async (overlay): Promise<EpmDocument | null> => {
        const attachment = await openProject
          .request<OpAttachment>(`/attachments/${overlay.openProjectId}`, { signal })
          .catch(() => null);

        // Gone upstream, or not readable by this caller. Either way it is not
        // theirs to see, and a row pointing at nothing helps no one.
        if (!attachment) return null;

        if (needle && !attachment.fileName.toLowerCase().includes(needle)) return null;

        return {
          id: overlay.openProjectId,
          name: attachment.fileName,
          kind:
            (overlay.kind as DocumentKind) ?? kindOf(attachment.fileName, attachment.contentType),
          projectId: overlay.projectId ?? undefined,
          ownerId: linkId(attachment._links, 'author') ?? '',
          sizeBytes: attachment.fileSize,
          updatedAt: attachment.createdAt,
          shared: overlay.shared,
          // Whether the delete action is offered at all. Taken per document,
          // because OpenProject decides per document.
          can: { delete: Object.hasOwn(attachment._links ?? {}, 'delete') },
        };
      }),
    );

    return documents.filter((document): document is EpmDocument => document !== null);
  });

  /**
   * Uploads a document.
   *
   * A real multipart upload, stored as a container-less OpenProject
   * attachment.
   *
   * Container-less whether or not a project is named, because
   * `POST /projects/:id/attachments` is not an upload endpoint — it answers
   * 415 `TypeNotSupported` to multipart, wanting JSON. `POST /attachments` is
   * the one that takes bytes. The project a document belongs to is therefore
   * EPM's own record, which is what `DocumentMeta.projectId` has always been
   * for, and what the listing above already prefers over the container link.
   *
   * The overlay row carries what upstream has no field for — the kind EPM
   * groups by, and whether the document is shared. It is written after the
   * upload, so a failed upload never leaves a row describing a file that does
   * not exist.
   */
  app.post('/documents', async (request, reply): Promise<EpmDocument> => {
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

    // `truncated` is how the reader reports that it stopped at the limit; the
    // partial file must not be stored as if it were whole.
    if (uploaded.file.truncated) {
      throw EpmError.badRequest(
        `That file is larger than the ${Math.floor(limit / 1024 / 1024)} MB limit.`,
      );
    }

    const fileName = uploaded.filename?.trim();
    if (!fileName) throw EpmError.badRequest('The file has no name.');

    // Multipart fields arrive beside the file rather than as a JSON body.
    const field = (name: string): string | undefined => {
      const value = uploaded.fields?.[name];
      const entry = Array.isArray(value) ? value[0] : value;
      const text = entry && 'value' in entry ? String(entry.value).trim() : '';
      return text || undefined;
    };

    const projectId = field('projectId');
    if (projectId && !/^\d+$/.test(projectId)) {
      throw EpmError.badRequest('That project is not valid.');
    }

    /*
     * Not guarded here, and deliberately.
     *
     * `document:upload` has no action in the capabilities vocabulary, so EPM
     * has nothing authoritative to check it against — which is why it is
     * denied by default and why this endpoint refused every upload. Denying
     * outright is as much a guess as allowing outright.
     *
     * OpenProject decides instead: creating an attachment on a project is
     * governed by its own permissions, and it answers 403 with the reason.
     * That is the same reasoning as `guard.requireLink` and the time entry
     * routes — the instance is stricter than any mapping, and it is right.
     */

    const form = new FormData();
    // A plain string field, not a typed part: OpenProject parses this itself,
    // and sending it as a blob makes Rails hand it over as a hash instead.
    form.append('metadata', JSON.stringify({ fileName }));
    // The declared content type is the client's claim, so it is not forwarded
    // as fact; OpenProject sniffs and stores its own.
    form.append('file', new Blob([buffer]), fileName);

    const created = await openProject
      .request<OpAttachment>('/attachments', { method: 'POST', body: form, signal })
      .catch((error) => {
        if (error instanceof OpenProjectError) {
          if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
          if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
        }
        throw error;
      });

    const id = String(created.id);
    const kind = kindOf(created.fileName, created.contentType);
    const shared = field('shared') === 'true';

    // Best effort: the file is stored either way, and losing the overlay costs
    // a grouping hint rather than the document.
    await optional(
      () =>
        prisma.documentMeta.upsert({
          where: { openProjectId: id },
          create: { openProjectId: id, kind, shared, projectId: projectId ?? null },
          update: { kind, shared, projectId: projectId ?? null },
        }),
      null,
    );

    // Tell the project, if anybody asked to be told. Not awaited: the file is
    // stored, and the uploader should not wait on a mail fan-out to see it.
    void notifyDocumentUploaded({
      id,
      name: created.fileName,
      projectId: projectId ?? null,
      uploadedBy: request.auth?.userId ?? '',
    });

    reply.code(201);
    return {
      id,
      name: created.fileName,
      kind,
      projectId,
      ownerId: linkId(created._links, 'author') ?? '',
      sizeBytes: created.fileSize,
      updatedAt: created.createdAt,
      shared,
      can: { delete: Object.hasOwn(created._links ?? {}, 'delete') },
    };
  });

  /**
   * Streams a document back.
   *
   * Proxied rather than redirected, for the same reason attachments are: the
   * browser holds no upstream credential and must never be handed an
   * OpenProject URL.
   */
  app.get<{ Params: { id: string } }>('/documents/:id/content', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That document');

    const attachment = await openProject
      .request<OpAttachment>(`/attachments/${id}`, { signal: requestSignal(request) })
      .catch(() => null);

    if (!attachment) throw EpmError.notFound('That document');

    const upstream = await openProject.stream(
      `/attachments/${id}/content`,
      requestSignal(request),
    );

    if (!upstream.ok || !upstream.body) throw EpmError.notFound('That document');

    return reply
      .header('Content-Type', attachment.contentType || 'application/octet-stream')
      // Always an attachment: a document library must not become a way to serve
      // active content from EPM's own origin.
      .header('Content-Disposition', contentDispositionFor(attachment.fileName))
      // OpenProject marks these publicly cacheable; they are private records
      // behind a session, and a shared cache must not keep them.
      .header('Cache-Control', 'private, no-store')
      // The content type is the uploader's claim; stop browsers improving on it.
      .header('X-Content-Type-Options', 'nosniff')
      .send(upstream.body);
  });

  /**
   * Removes a document.
   *
   * The file upstream and the overlay row that indexes it, in that order: the
   * listing is driven by the overlay, so deleting the row first would hide a
   * file that still existed and leave nothing pointing at it.
   *
   * Not guarded against a capability, for the same reason the upload is not —
   * there is no documents action in the vocabulary to check. OpenProject
   * decides, and it publishes a `delete` link on the attachment only for
   * somebody who may really remove it, which is what `requireLink` reads. The
   * grid offers the action on the same signal, so the button and the endpoint
   * cannot disagree.
   */
  app.delete<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That document');

    // Reachability first. An id this caller cannot read is reported absent
    // rather than forbidden: a 403 would confirm the document exists, which is
    // exactly what they should not learn.
    const attachment = await openProject
      .request<OpAttachment>(`/attachments/${id}`, { signal: requestSignal(request) })
      .catch(() => null);

    if (!attachment) throw EpmError.notFound('That document');

    await guard.requireLink(request, `/attachments/${id}`, 'delete', 'delete this document');

    await openProject.request<void>(`/attachments/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    /*
     * The index row goes too.
     *
     * `deleteMany` rather than `delete`, because a missing row is the outcome
     * being asked for and Prisma treats it as an error. Best effort either way:
     * the file is already gone, and failing the request now would tell the
     * caller the deletion did not happen when it did. A row left behind drops
     * out of the listing on its own — the lookup above returns nothing for it.
     */
    await optional(() => prisma.documentMeta.deleteMany({ where: { openProjectId: id } }), null);

    reply.code(204);
  });
};
