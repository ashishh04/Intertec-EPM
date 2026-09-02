/**
 * Keeps the backend's copy of the EPM domain models identical to the
 * frontend's.
 *
 * `frontend/src/types/index.ts` is the single source of truth for the contract —
 * it is what every page and hook is typed against. This backend mirrors it so
 * responses cannot drift from what the UI expects.
 *
 *   npm run types:check   verify (runs as part of `npm run lint`)
 *   npm run types:sync    copy the frontend file over the backend's
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const SOURCE = resolve(repoRoot, 'frontend/src/types/index.ts');
const MIRROR = resolve(repoRoot, 'backend/src/types/epm.ts');

const mode = process.argv[2] === '--write' ? 'write' : 'check';

const source = readFileSync(SOURCE, 'utf8');

if (mode === 'write') {
  writeFileSync(MIRROR, source);
  console.log(`Synced ${MIRROR} from ${SOURCE}`);
  process.exit(0);
}

let mirror: string;
try {
  mirror = readFileSync(MIRROR, 'utf8');
} catch {
  console.error(`Missing ${MIRROR}. Run: npm run types:sync`);
  process.exit(1);
}

if (source !== mirror) {
  console.error(
    'The EPM domain models have drifted from the frontend contract.\n' +
      `  source: ${SOURCE}\n` +
      `  mirror: ${MIRROR}\n\n` +
      'Run `npm run types:sync`, then fix any resulting type errors — a change\n' +
      'here means the API response shape the frontend expects has changed.',
  );
  process.exit(1);
}

console.log('EPM domain models are in sync with the frontend contract.');
