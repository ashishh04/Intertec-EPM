#!/usr/bin/env node
/**
 * Rewrites physical-direction Tailwind classes as logical ones (BR-601).
 *
 *   node scripts/rtl-logical.mjs            report what would change
 *   node scripts/rtl-logical.mjs --write    change it
 *   node scripts/rtl-logical.mjs --write src/pages/Foo.tsx …   only these files
 *
 * `ml-4` becomes `ms-4` (margin at the start of the line), `text-right` becomes
 * `text-end`, `rounded-tl-lg` becomes `rounded-ss-lg`, and so on: one class that
 * means the right thing in both directions, instead of a pair of classes per
 * direction. Re-running it changes nothing, so it can be run again over files
 * that arrive later with physical classes in them.
 *
 * Only class-shaped text is touched: the value after the prefix must be a
 * Tailwind value (a number, px, auto, full, a fraction, an arbitrary [..] value
 * or a colour name), and the class must stand alone between quotes, spaces or a
 * variant colon — so prose such as "right-click" or "left to right" is left
 * alone. What a class cannot express (an inline `style`, an SVG coordinate, a
 * transform) is reported, not rewritten: those are decided by hand.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const write = process.argv.includes('--write');
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

/**
 * Files left alone for now. Module 11 (earned value) is changing these on
 * another branch; converting them here would collide with that work. They are
 * converted by running this again once it is merged.
 */
const DEFERRED = new Set([
  'pages/InsightsPage.tsx',
  'pages/TaskDetailPage.tsx',
  'components/insights/MeasureSeriesChart.tsx',
  'components/insights/format.ts',
  'config/administration.ts',
]);

/**
 * Files whose left and right are physical on purpose. The sheet's `side` prop
 * names a physical edge — callers choose the edge by direction — so its
 * variants must stay `left-0` and `right-0`.
 */
const PHYSICAL = new Set(['components/ui/sheet.tsx']);

const BEFORE = String.raw`(?<=^|[\s"'\x60:!{(,])`;
const AFTER = String.raw`(?=$|[\s"'\x60}),\]])`;
const SIZE = String.raw`(?:\d+(?:\.\d+)?|px|auto|full|\d+\/\d+|\[[^\]\s"'\x60]+\])`;
const COLOUR = String.raw`(?:[a-z]+(?:-[a-z]+)*(?:-\d{2,3})?(?:\/\d{1,3})?|\[[^\]\s"'\x60]+\])`;

/** [pattern, replacement] — the replacement keeps the sign and the value. */
const RULES = [
  [new RegExp(`${BEFORE}(-?)m([lr])-(${SIZE})${AFTER}`, 'g'), (_, sign, side, value) => `${sign}m${side === 'l' ? 's' : 'e'}-${value}`],
  [new RegExp(`${BEFORE}p([lr])-(${SIZE})${AFTER}`, 'g'), (_, side, value) => `p${side === 'l' ? 's' : 'e'}-${value}`],
  // Not `left-1/2`: that is centring (with -translate-x-1/2), which is the same
  // in both directions and would be pushed off-centre by a logical inset.
  [new RegExp(`${BEFORE}(-?)(left|right)-(?!1\\/2${AFTER})(${SIZE})${AFTER}`, 'g'), (_, sign, side, value) => `${sign}${side === 'left' ? 'start' : 'end'}-${value}`],
  [new RegExp(`${BEFORE}text-(left|right)${AFTER}`, 'g'), (_, side) => `text-${side === 'left' ? 'start' : 'end'}`],
  [new RegExp(`${BEFORE}border-([lr])${AFTER}`, 'g'), (_, side) => `border-${side === 'l' ? 's' : 'e'}`],
  [new RegExp(`${BEFORE}border-([lr])-(${SIZE}|${COLOUR})${AFTER}`, 'g'), (_, side, value) => `border-${side === 'l' ? 's' : 'e'}-${value}`],
  [new RegExp(`${BEFORE}rounded-([lr])${AFTER}`, 'g'), (_, side) => `rounded-${side === 'l' ? 's' : 'e'}`],
  [new RegExp(`${BEFORE}rounded-([lr])-(none|sm|md|lg|xl|2xl|3xl|full|\\[[^\\]]+\\])${AFTER}`, 'g'), (_, side, value) => `rounded-${side === 'l' ? 's' : 'e'}-${value}`],
  [new RegExp(`${BEFORE}rounded-(tl|tr|bl|br)${AFTER}`, 'g'), (_, corner) => `rounded-${CORNERS[corner]}`],
  [new RegExp(`${BEFORE}rounded-(tl|tr|bl|br)-(none|sm|md|lg|xl|2xl|3xl|full|\\[[^\\]]+\\])${AFTER}`, 'g'), (_, corner, value) => `rounded-${CORNERS[corner]}-${value}`],
  [new RegExp(`${BEFORE}scroll-([mp])([lr])-(${SIZE})${AFTER}`, 'g'), (_, box, side, value) => `scroll-${box}${side === 'l' ? 's' : 'e'}-${value}`],
];

const CORNERS = { tl: 'ss', tr: 'se', bl: 'es', br: 'ee' };

/** Patterns that need a decision by hand; reported with their line. */
const MANUAL = [
  [/\b(?:-?translate-x-|space-x-\d|divide-x|origin-(?:left|right)|bg-gradient-to-(?:r|l|tr|tl|br|bl)|slide-(?:in|out)-from-(?:left|right))/, 'class with no logical form'],
  [/\b(?:left|right|marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\s*:/, 'inline style'],
  [/\bside=["'](?:left|right)["']/, 'Radix side'],
  [/\b(?:scrollLeft|offsetLeft|getBoundingClientRect)\b/, 'measured position'],
  [/\b(?:ArrowLeft|ArrowRight|ChevronLeft|ChevronRight|ChevronsLeft|ChevronsRight)\b/, 'directional icon'],
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

const targets = only.length ? only.map((file) => join(process.cwd(), file)) : [...files(root)];

let changedFiles = 0;
let changes = 0;
const manual = [];
const deferred = [];

for (const path of targets) {
  const name = relative(root, path).replaceAll('\\', '/');
  if (DEFERRED.has(name)) {
    deferred.push(name);
    continue;
  }
  if (PHYSICAL.has(name)) continue;
  const before = readFileSync(path, 'utf8');
  let after = before;
  for (const [pattern, replacement] of RULES) {
    after = after.replace(pattern, (...args) => {
      changes += 1;
      return replacement(...args);
    });
  }
  if (after !== before) {
    changedFiles += 1;
    if (write) writeFileSync(path, after);
  }
  after.split('\n').forEach((line, index) => {
    // Comments describe layout in words ("what is left: …"); they are not layout.
    if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
    for (const [pattern, kind] of MANUAL) {
      if (pattern.test(line)) manual.push(`${name}:${index + 1}  [${kind}]  ${line.trim().slice(0, 110)}`);
    }
  });
}

console.log(`${write ? 'Rewrote' : 'Would rewrite'} ${changes} class${changes === 1 ? '' : 'es'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}.`);
if (deferred.length) console.log(`Deferred (Module 11): ${deferred.join(', ')}`);
if (manual.length) {
  console.log(`\nTo decide by hand (${manual.length}):`);
  for (const line of manual) console.log(`  ${line}`);
}
