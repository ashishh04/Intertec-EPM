/**
 * Keeps the backend's copies of shared frontend files identical to the
 * originals.
 *
 * `frontend/src/types/index.ts` is the single source of truth for the contract —
 * it is what every page and hook is typed against. This backend mirrors it so
 * responses cannot drift from what the UI expects. The message format the
 * translations are written in (`lib/messageformat.ts`) is mirrored the same
 * way, so a message renders identically on screen, in an email and in a PDF.
 *
 *   npm run types:check   verify (runs as part of `npm run lint`)
 *   npm run types:sync    copy the frontend files over the backend's
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const PAIRS = [
  { source: 'frontend/src/types/index.ts', mirror: 'backend/src/types/epm.ts', what: 'The EPM domain models' },
  { source: 'frontend/src/lib/messageformat.ts', mirror: 'backend/src/lib/messageformat.ts', what: 'The message format' },
].map((pair) => ({ ...pair, source: resolve(repoRoot, pair.source), mirror: resolve(repoRoot, pair.mirror) }));

const mode = process.argv[2] === '--write' ? 'write' : 'check';

if (mode === 'write') {
  for (const { source, mirror } of PAIRS) {
    writeFileSync(mirror, readFileSync(source, 'utf8'));
    console.log(`Synced ${mirror} from ${source}`);
  }
  process.exit(0);
}

let drifted = false;
for (const { source, mirror, what } of PAIRS) {
  let copy: string;
  try {
    copy = readFileSync(mirror, 'utf8');
  } catch {
    console.error(`Missing ${mirror}. Run: npm run types:sync`);
    drifted = true;
    continue;
  }
  if (readFileSync(source, 'utf8') !== copy) {
    console.error(
      [
        `${what} have drifted from the frontend.`,
        `  source: ${source}`,
        `  mirror: ${mirror}`,
        '',
        'Run `npm run types:sync`, then fix any resulting type errors — a change',
        'here means what the frontend expects has changed.',
      ].join('\n'),
    );
    drifted = true;
  }
}

if (drifted) process.exit(1);
console.log('EPM domain models and the message format are in sync with the frontend.');
