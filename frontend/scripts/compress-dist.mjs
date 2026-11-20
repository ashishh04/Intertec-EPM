import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/**
 * Writes a compressed copy beside each built file worth compressing — `.br`
 * (Brotli at its best setting) and `.gz` — for the web server to send as they
 * are (Caddyfile: `file_server { precompressed br gzip }`) rather than
 * compressing every response on its way out. Smaller than compressing as it
 * goes, which has to be quick, and no work per request: Brotli at its best
 * takes a few seconds a file, once, here.
 */

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.webmanifest']);
/** Below this a compressed copy saves less than its headers cost. */
const MIN_BYTES = 1024;

function* filesIn(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesIn(path);
    else yield path;
  }
}

let count = 0;
let raw = 0;
let brotli = 0;
for (const path of filesIn(DIST)) {
  if (!TYPES.has(extname(path))) continue;
  const data = readFileSync(path);
  if (data.length < MIN_BYTES) continue;
  const br = zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.gz`, zlib.gzipSync(data, { level: 9 }));
  count += 1;
  raw += data.length;
  brotli += br.length;
}

const kb = (bytes) => `${Math.round(bytes / 1024)} kB`;
console.log(`compressed ${count} files: ${kb(raw)} → ${kb(brotli)} with Brotli`);
