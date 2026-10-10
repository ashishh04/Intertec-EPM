import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import bidiModule, { type Bidi } from 'bidi-js';
import * as fontkit from 'fontkit';

/**
 * Arabic in PDF reports (BR-604, BR-602).
 *
 * The standard Helvetica faces stop at Windows-1252, so Arabic needs three
 * things the rest of `pdf.ts` does not: a font that has the letters (IBM Plex
 * Sans Arabic, the face the screens use, embedded and subset), shaping — an
 * Arabic letter takes a different form at the start, middle and end of a word,
 * and some pairs join into one glyph — and bidirectional ordering, so a line
 * that mixes Arabic, a Latin reference and a number reads in the right order.
 *
 * `fontkit` does the shaping from the font's own tables and `bidi-js` the
 * Unicode Bidirectional Algorithm; this module turns a line into runs in the
 * order they are drawn, left to right. Latin runs stay in Helvetica, so a
 * report with no Arabic in it is byte-for-byte what it was: the slow path is
 * taken only by a line that has right-to-left text in it.
 */

const require = createRequire(import.meta.url);
// A CommonJS package: Node hands over the factory itself, the typings describe
// it as `default`. Either way it is the same function.
const bidiFactory = ((bidiModule as unknown as { default?: () => Bidi }).default ??
  (bidiModule as unknown as () => Bidi));
const bidi = bidiFactory();

export type Face = 'regular' | 'bold';

const FILES: Record<Face, string> = {
  regular: '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff',
  bold: '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff',
};

const fonts: Partial<Record<Face, fontkit.Font>> = {};

/** The Arabic face, read once. */
export function arabicFont(face: Face): fontkit.Font {
  let font = fonts[face];
  if (!font) {
    font = fontkit.create(readFileSync(require.resolve(FILES[face]))) as fontkit.Font;
    fonts[face] = font;
  }
  return font;
}

/** Right-to-left text, or the controls that isolate a value inside it. */
const COMPLEX = /[֐-ࣿיִ-﷿ﹰ-﻿‎‏‪-‮⁦-⁩]/;
/** The blocks the Arabic face draws. */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
/** Direction marks and isolates: they order the text and are never drawn. */
const CONTROL = /[‎‏‪-‮⁦-⁩]/;

/** Whether a line needs shaping and reordering, or can go straight to Helvetica. */
export function isComplex(text: string): boolean {
  return COMPLEX.test(text);
}

export interface Run {
  kind: 'latin' | 'arabic';
  /** A Latin run's characters, already in drawing order. */
  text: string;
  /** An Arabic run's glyphs, in drawing order, with each one's advance in font units. */
  glyphs: fontkit.Glyph[];
  advances: number[];
  /** Points, at the size it was laid out. */
  width: number;
}

export interface Line {
  runs: Run[];
  width: number;
}

/**
 * A line as runs in drawing order.
 *
 * The paragraph direction comes from the line's first strong character, as a
 * browser does with `dir="auto"`, unless `direction` says otherwise. The
 * characters are reordered visually by the bidi algorithm; consecutive ones of
 * the same script and level then form a run. An Arabic run is shaped from its
 * logical text and comes back from fontkit already in visual order.
 */
export function layoutLine(
  text: string,
  size: number,
  bold: boolean,
  latinWidth: (text: string, size: number, bold: boolean) => number,
  direction?: 'ltr' | 'rtl',
): Line {
  const font = arabicFont(bold ? 'bold' : 'regular');
  const embedding = bidi.getEmbeddingLevels(text, direction);
  const levels = embedding.levels;

  // Which face draws each character. A space takes the face of the letter
  // before it, so Arabic words separated by spaces stay one run.
  const kinds: ('arabic' | 'latin' | 'control')[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (CONTROL.test(char)) kinds.push('control');
    else if (ARABIC.test(char)) kinds.push('arabic');
    else if (char === ' ' && kinds[i - 1] === 'arabic' && ARABIC.test(text[i + 1] ?? '')) kinds.push('arabic');
    else kinds.push('latin');
  }

  // Visual order: apply the algorithm's reversals to the logical indices
  // (code units, as bidi-js counts them).
  const order = Array.from({ length: text.length }, (_, index) => index);
  for (const segment of bidi.getReorderSegments(text, embedding)) {
    const [start, end] = segment as [number, number];
    const reversed = order.slice(start, end + 1).reverse();
    order.splice(start, end - start + 1, ...reversed);
  }
  const mirrored = bidi.getMirroredCharactersMap(text, levels);

  const runs: Run[] = [];
  let index = 0;
  while (index < order.length) {
    const first = order[index]!;
    const kind = kinds[first]!;
    if (kind === 'control') {
      index += 1;
      continue;
    }
    const level = levels[first]!;
    const members = [first];
    while (index + members.length < order.length) {
      const next = order[index + members.length]!;
      if (kinds[next] !== kind || levels[next] !== level) break;
      members.push(next);
    }
    index += members.length;

    if (kind === 'arabic') {
      const from = Math.min(...members);
      const to = Math.max(...members);
      const shaped = font.layout(text.slice(from, to + 1), undefined, 'arab', undefined, level % 2 ? 'rtl' : 'ltr');
      const advances = shaped.positions.map((position) => position.xAdvance);
      const units = advances.reduce((sum, advance) => sum + advance, 0);
      runs.push({ kind, text: '', glyphs: shaped.glyphs, advances, width: (units * size) / font.unitsPerEm });
    } else {
      const visual = members.map((at) => mirrored.get(at) ?? text[at]!).join('');
      runs.push({ kind, text: visual, glyphs: [], advances: [], width: latinWidth(visual, size, bold) });
    }
  }

  return { runs, width: runs.reduce((sum, run) => sum + run.width, 0) };
}
