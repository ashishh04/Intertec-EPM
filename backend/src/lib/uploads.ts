import { referenceCache } from './cache.js';
import { openProject } from '../openproject/client.js';

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
