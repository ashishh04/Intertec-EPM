import { referenceCache } from './cache.js';
import { openProject } from '../openproject/client.js';
import type { DocumentKind } from '../types/epm.js';

/**
 * Shared rules for files travelling through EPM.
 *
 * Both the work package attachment routes and the document library upload to
 * the same instance and serve back through the same origin, so the size
 * ceiling and the download header belong in one place rather than two.
 */

/**
 * The instance's upload ceiling.
 *
 * Read from OpenProject rather than assumed, because rejecting at a size it
 * would have accepted is as wrong as accepting one it will refuse. Cached: it
 * is configuration, not per-request data.
 */
export async function maxUploadBytes(signal: AbortSignal): Promise<number> {
  return referenceCache.get('max-attachment-size', async () => {
    const configuration = await openProject
      .request<{ maximumAttachmentFileSize?: number }>('/configuration', { signal })
      .catch(() => null);

    // A conservative floor if the instance will not say.
    return configuration?.maximumAttachmentFileSize ?? 5 * 1024 * 1024;
  }) as Promise<number>;
}

/** Printable ASCII, which is all a header value may safely carry unencoded. */
function isHeaderSafe(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  // Below 0x20 is a control character — CR and LF would end the header and let
  // a filename inject another one. 0x7f is DEL, equally unwelcome.
  return code >= 0x20 && code !== 0x7f;
}

/**
 * A filename safe to put in a header.
 *
 * OpenProject already strips path separators — `../../etc/passwd` is stored as
 * `passwd` — but this does not rely on that. Anything that could terminate the
 * header or inject another one is removed, and the original is additionally
 * offered RFC 5987 encoded so non-ASCII names survive intact.
 *
 * The character test is a predicate rather than a regex range: expressing it as
 * one put literal NUL and DEL bytes in the source, invisible to a reader and
 * enough to make `grep` treat the file as binary.
 */
export function contentDispositionFor(fileName: string): string {
  const cleaned = Array.from(fileName)
    .filter(isHeaderSafe)
    .join('')
    .replace(/[\\"]/g, '')
    .replace(/[/]/g, '_')
    .slice(0, 200);

  // The unencoded parameter must be ASCII; anything else travels in the
  // RFC 5987 form beside it.
  const fallback =
    Array.from(cleaned)
      .map((character) => ((character.codePointAt(0) ?? 0) <= 0x7e ? character : '_'))
      .join('') || 'download';

  // Always `attachment`. Serving an upload inline would let an uploaded HTML or
  // SVG file execute as script in EPM's own origin, and OpenProject trusts the
  // content type the uploader declared.
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** The library's grouping for each file extension it recognises. */
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

/**
 * Every kind the library groups by, which is every kind a client knows how to
 * draw. A record rather than a list, so a kind added to the type and not here
 * fails to compile.
 */
const DOCUMENT_KINDS: Record<DocumentKind, true> = {
  pdf: true,
  doc: true,
  sheet: true,
  slide: true,
  image: true,
  archive: true,
  markdown: true,
};

export function isDocumentKind(value: string): value is DocumentKind {
  return Object.hasOwn(DOCUMENT_KINDS, value);
}

/**
 * The kind a filed document is grouped under: by its extension, then by the
 * content type OpenProject stored, and a plain document otherwise.
 *
 * Every route that files a document uses this, the library and the client
 * portal alike, so a file is grouped the same way whoever uploaded it.
 */
export function documentKindOf(fileName: string, contentType: string): DocumentKind {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  // Own keys only: a file called `notes.constructor` must not find Object's.
  if (Object.hasOwn(EXTENSION_KIND, extension)) return EXTENSION_KIND[extension] as DocumentKind;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.includes('pdf')) return 'pdf';
  return 'doc';
}
