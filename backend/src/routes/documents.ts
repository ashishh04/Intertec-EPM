import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
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
  app.get('/documents', async (request) => {
    const { projectId, search } = z
      .object({ projectId: z.string().optional(), search: z.string().optional() })
      .parse(request.query);

    const signal = requestSignal(request);

    const attachments = await openProject
      .getAll<OpAttachment>('/attachments', { pageSize: 100 }, { signal })
      .catch(() => ({ items: [] as OpAttachment[] }));

    const overlays = await optional(() => prisma.documentMeta.findMany(), []);
    const overlayById = new Map(overlays.map((row) => [row.openProjectId, row]));

    let documents = attachments.items.map((attachment): EpmDocument => {
      const id = String(attachment.id);
      const overlay = overlayById.get(id);

      return {
        id,
        name: attachment.fileName,
        kind: (overlay?.kind as DocumentKind) ?? kindOf(attachment.fileName, attachment.contentType),
        projectId: overlay?.projectId ?? linkId(attachment._links, 'container'),
        ownerId: linkId(attachment._links, 'author') ?? '',
        sizeBytes: attachment.fileSize,
        updatedAt: attachment.createdAt,
        shared: overlay?.shared ?? false,
      };
    });

    if (projectId) documents = documents.filter((document) => document.projectId === projectId);
    if (search) {
      const needle = search.toLowerCase();
      documents = documents.filter((document) => document.name.toLowerCase().includes(needle));
    }

    return documents;
  });

  /**
   * The contract posts metadata only, with no file bytes. Creating an
   * OpenProject attachment requires a multipart upload, so rather than record a
   * document that does not exist upstream this reports the capability as
   * missing.
   */
  app.post('/documents', async () => {
    throw new EpmError(
      501,
      'UPSTREAM_ERROR',
      'Uploading documents is not available yet — the backend cannot store files in OpenProject without a multipart upload endpoint.',
    );
  });
};
