import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Checks that nothing about the upstream system reached the browser.
 *
 * This exists because the ad-hoc `grep -rioF` this replaced returned 0 for
 * every pattern **whether or not the string was present** — `-F` silently
 * matches nothing on these minified chunks. Six chunks contained the upstream
 * product name for weeks while the audit reported a clean bill.
 *
 * So there is a control pattern: a string that must be found. If the control
 * fails, the audit itself is broken and the run fails loudly rather than
 * reporting a false pass.
 */

const FORBIDDEN = [
  'openproject',
  'localhost:8080',
  'bearer ',
  'authorization',
  'access_token',
  'refresh_token',
  'api/v3',
  'apikey',
  'epm_admin_user_ids',
];

/** Must be present. Its absence means the audit is not reading anything. */
const CONTROL = 'react';

const assetsDir = join(process.cwd(), 'dist', 'assets');

let files;
try {
  files = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
} catch {
  console.error(`No build to audit at ${assetsDir}. Run "npm run build" first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error('No JavaScript chunks found to audit.');
  process.exit(1);
}

const haystack = files.map((name) => ({
  name,
  text: readFileSync(join(assetsDir, name), 'utf8').toLowerCase(),
}));

const hits = new Map();
for (const pattern of FORBIDDEN) {
  const where = haystack.filter((file) => file.text.includes(pattern)).map((file) => file.name);
  if (where.length > 0) hits.set(pattern, where);
}

const controlFound = haystack.some((file) => file.text.includes(CONTROL));

console.log(`Audited ${files.length} chunk${files.length === 1 ? '' : 's'} in dist/assets`);

if (!controlFound) {
  console.error(
    `\nThe control pattern "${CONTROL}" was not found. The audit is not working, so its ` +
      'result means nothing. Failing rather than reporting a pass.',
  );
  process.exit(2);
}

if (hits.size === 0) {
  console.log(`All ${FORBIDDEN.length} patterns clean.`);
  process.exit(0);
}

console.error('\nForbidden strings reached the browser bundle:\n');
for (const [pattern, where] of hits) {
  console.error(`  ${pattern}`);
  for (const name of where) console.error(`      ${name}`);
}
console.error('');
process.exit(1);
