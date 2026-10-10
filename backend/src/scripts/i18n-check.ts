/**
 * The translation check (BR-605): every string the product can show has an
 * Arabic translation, and every translation uses the same arguments as its
 * English.
 *
 *   npm run i18n:check                       both catalogues, whole source
 *   npm run i18n:check -- --scan <files…>    also list English left unwrapped in these files
 *   npm run i18n:check -- --catalogue <json> also count this extra catalogue as translated
 *
 * Messages are found where they are written: `t('…')` and `msg('…')` in the
 * frontend; in the backend, `t(language, '…')`, `message('…')`, `tr('…')` and
 * the literal first argument of an `EpmError.*(…)` call. A message must be a
 * literal at its call site for this to see it — which is the rule the code
 * follows anyway, so that the English can be the key.
 *
 * Exit status 1 when anything is missing or mismatched, so CI can hold it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidMessage, messageArguments } from '../lib/messageformat.js';
import { ar as backendCatalogue } from '../i18n/ar.js';
import { PHRASES } from '../i18n/phrases.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const frontendSrc = join(repo, 'frontend/src');
const backendSrc = join(repo, 'backend/src');

const args = process.argv.slice(2);
const option = (name: string): string[] => {
  const at = args.indexOf(name);
  if (at < 0) return [];
  const values: string[] = [];
  for (let i = at + 1; i < args.length && !args[i]!.startsWith('--'); i += 1) values.push(args[i]!);
  return values;
};

const extra: Record<string, string> = {};
for (const file of option('--catalogue')) Object.assign(extra, JSON.parse(readFileSync(file, 'utf8')));

const frontendCatalogue: Record<string, string> = {
  ...JSON.parse(readFileSync(join(frontendSrc, 'i18n/ar.json'), 'utf8')),
  ...extra,
};
const serverCatalogue: Record<string, string> = { ...backendCatalogue, ...extra };

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'i18n' || name === '__checks__') continue;
      yield* sources(path);
    } else if (/\.(tsx?|mts)$/.test(name) && !name.endsWith('.d.ts')) {
      yield path;
    }
  }
}

/** A JS string literal's value, from its quoted source. */
function unquote(quote: string, body: string): string {
  if (quote === '`') return body.replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  return body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
}

const LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;

const FRONTEND_CALLS = [new RegExp(String.raw`\b(?:t|msg)\(\s*${LITERAL}`, 'g')];
const BACKEND_CALLS = [
  new RegExp(String.raw`\bt\(\s*[\w.]+\s*,\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`\b(?:message|messageOf|tr|msg)\(\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`\bEpmError\.\w+\(\s*${LITERAL}`, 'g'),
];

interface Found {
  key: string;
  file: string;
  line: number;
}

function collect(root: string, patterns: RegExp[]): { found: Found[]; dynamic: Found[] } {
  const found: Found[] = [];
  const dynamic: Found[] = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const [, quote, body] = match;
        const line = text.slice(0, match.index).split('\n').length;
        const at = { key: unquote(quote!, body!), file: relative(repo, file).replaceAll('\\', '/'), line };
        // A template literal with ${…} in it is built at run time and cannot be a key.
        if (quote === '`' && /\$\{/.test(body!)) dynamic.push(at);
        else found.push(at);
      }
    }
  }
  return { found, dynamic };
}

let problems = 0;

/** With --scan, the report covers the messages in those files only. */
const scope = new Set(option('--scan').map((name) => relative(repo, resolve(process.cwd(), name)).split(sep).join('/')));
const inScope = (entry: Found) => scope.size === 0 || scope.has(entry.file);

function report(side: string, root: string, patterns: RegExp[], catalogue: Record<string, string>) {
  const collected = collect(root, patterns);
  const found = collected.found.filter(inScope);
  const dynamic = collected.dynamic.filter(inScope);
  const keys = new Map<string, Found>();
  for (const entry of found) if (!keys.has(entry.key)) keys.set(entry.key, entry);

  const missing = [...keys.values()].filter((entry) => catalogue[entry.key] === undefined);
  const broken = [...keys.keys()].filter((key) => !isValidMessage(key));
  const mismatched = [...keys.keys()].filter((key) => {
    const translated = catalogue[key];
    if (translated === undefined) return false;
    if (!isValidMessage(translated)) return true;
    return messageArguments(key).join(',') !== messageArguments(translated).join(',');
  });

  console.log(`\n${side}: ${keys.size} messages, ${keys.size - missing.length} translated, ${missing.length} missing`);
  for (const entry of missing.slice(0, 400)) console.log(`  MISSING  ${entry.file}:${entry.line}  ${JSON.stringify(entry.key)}`);
  if (missing.length > 400) console.log(`  … and ${missing.length - 400} more`);
  for (const key of broken) console.log(`  UNPARSEABLE  ${JSON.stringify(key)}`);
  for (const key of mismatched) {
    console.log(`  ARGUMENTS  ${JSON.stringify(key)}  →  ${JSON.stringify(catalogue[key])}`);
  }
  for (const entry of dynamic) console.log(`  DYNAMIC  ${entry.file}:${entry.line}  ${entry.key.slice(0, 80)}`);
  problems += missing.length + broken.length + mismatched.length + dynamic.length;
}

report('Frontend', frontendSrc, FRONTEND_CALLS, frontendCatalogue);
report('Backend', backendSrc, BACKEND_CALLS, serverCatalogue);

/*
 * Words the backend sends as data rather than in a message: the EPM permission
 * catalogue (translated by its route) and the registered argument phrases.
 * Read from the code itself, so an entry added later is checked too. The
 * catalogue is read as text: importing it would load the server's
 * configuration, and this check must run without a database or an .env.
 */
const grantSource = readFileSync(join(backendSrc, 'auth/grants.ts'), 'utf8');
const grantBlock = grantSource.slice(grantSource.indexOf('GRANT_CATALOGUE'), grantSource.indexOf('];', grantSource.indexOf('GRANT_CATALOGUE')));
const grantWords = [...grantBlock.matchAll(/\b(?:label|description):\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) =>
  unquote(match[1]!, match[2]!),
);
// The field descriptors EPM's OpenProject add-on serves for the administration
// catalogues and settings sections, translated as they pass through
// (lib/i18n.ts translateDescriptors).
const descriptorWords = ['zzz_epm_admin_catalog.rb', 'zzz_epm_admin_settings.rb'].flatMap((file) => {
  const ruby = readFileSync(join(repo, 'backend/openproject', file), 'utf8');
  return [...ruby.matchAll(/\b(?:label|description|help|title):\s*"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]!.replace(/\\"/g, '"'));
});
// …and the settings fields, declared as tuples — [key, type, options, "Label", "Help"] —
// where a long help may be split across adjacent literals.
const RUBY_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const settingsRuby = readFileSync(join(repo, 'backend/openproject/zzz_epm_admin_settings.rb'), 'utf8');
const FIELD = new RegExp(
  String.raw`\[\s*"[\w/]+",\s*:\w+,\s*(?::\w+|nil),\s*((?:${RUBY_STRING}\s*)+),\s*((?:${RUBY_STRING}\s*)+)\]`,
  'g',
);
const fieldWords = [...settingsRuby.matchAll(FIELD)].flatMap((match) =>
  [match[1]!, match[2]!].map((literals) =>
    [...literals.matchAll(new RegExp(RUBY_STRING, 'g'))].map((one) => JSON.parse(one[0]) as string).join(''),
  ),
);
const dataWords = [...new Set([...grantWords, ...descriptorWords, ...fieldWords, ...PHRASES])].filter(
  (word) => serverCatalogue[word] === undefined,
);
if (scope.size === 0) {
  console.log('');
  console.log(`Backend data words: ${dataWords.length} missing`);
  for (const word of dataWords) console.log(`  MISSING  (data)  ${JSON.stringify(word)}`);
  problems += dataWords.length;
}

/*
 * English left unwrapped. A heuristic, for the files named with --scan: JSX
 * text with letters in it, and the attributes people read, that do not go
 * through t(). Product names on their own are not text to translate.
 */
const scan = option('--scan');
if (scan.length) {
  const allowed = /^(?:EPM|OpenProject|Intertec|Intertec Systems|Pragnya|AED|CSV|XLSX|PDF|API|URL|ID|OK)$/;
  const jsxText = />\s*([^<>{}\n]*[A-Za-z]{2,}[^<>{}\n]*?)\s*</g;
  const attribute = /\b(placeholder|title|aria-label|alt|label|description|hint|tooltip)=(["'])([^"']*[A-Za-z]{2,}[^"']*)\2/g;
  let left = 0;
  for (const name of scan) {
    const file = resolve(process.cwd(), name);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
      for (const match of line.matchAll(jsxText)) {
        const text = match[1]!.trim();
        if (!text || allowed.test(text) || /^[\W\d_]+$/.test(text) || /=>|&&|\|\||===/.test(text)) continue;
        left += 1;
        console.log(`  TEXT  ${relative(repo, file)}:${index + 1}  ${text.slice(0, 90)}`);
      }
      for (const match of line.matchAll(attribute)) {
        if (allowed.test(match[3]!.trim())) continue;
        left += 1;
        console.log(`  ATTR  ${relative(repo, file)}:${index + 1}  ${match[1]}="${match[3]!.slice(0, 80)}"`);
      }
    });
  }
  console.log(`\nUnwrapped English in the scanned files: ${left}`);
  problems += left;
}

if (problems) process.exit(1);
console.log('\nEvery message has a translation.');
