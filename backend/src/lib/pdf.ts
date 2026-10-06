/**
 * PDF documents, written by hand, for reports sent by email (BR-208).
 *
 * What a report needs from PDF is narrow — text in two weights, filled and
 * stroked rectangles, lines, links and pages — and that much of the format is
 * a few hundred lines with no dependency. Text is set in the standard Helvetica
 * faces every reader carries, so nothing is embedded, and measured with their
 * published metrics so a column of figures lines up and long text wraps or is
 * shortened where it would overflow.
 *
 * The standard faces cover Latin script (Windows-1252). Characters outside it
 * are reduced to their unaccented letter where there is one and to "?" where
 * there is not; Arabic needs an embedded font and shaping, which come with
 * right-to-left support (Module 15).
 *
 * Content streams are not compressed: the files stay small for reports of this
 * size, the output is deterministic, and the text can be searched — which is
 * how a test checks what a report contains.
 */

export type Rgb = readonly [number, number, number];

export const COLOURS = {
  ink: [0.12, 0.13, 0.16],
  muted: [0.42, 0.45, 0.5],
  faint: [0.62, 0.64, 0.68],
  border: [0.88, 0.89, 0.91],
  zebra: [0.976, 0.98, 0.984],
  surface: [0.965, 0.961, 0.984],
  brand: [0.427, 0.157, 0.851],
  brandSoft: [0.93, 0.9, 0.99],
  danger: [0.73, 0.11, 0.11],
  warning: [0.71, 0.45, 0.04],
  success: [0.08, 0.5, 0.24],
  white: [1, 1, 1],
} as const satisfies Record<string, Rgb>;

/* -------------------------------------------------------------------------- */
/* Fonts and text                                                             */
/* -------------------------------------------------------------------------- */

// Advance widths in thousandths of an em for character codes 32 to 126, from
// the Adobe Font Metrics of Helvetica and Helvetica-Bold.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Windows-1252 bytes 0x80 to 0x9F, by code point.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
// Widths of those, in the regular face (the bold face is close enough for layout).
const CP1252_WIDTHS: Record<number, number> = {
  0x80: 556, 0x82: 222, 0x83: 556, 0x84: 333, 0x85: 1000, 0x86: 556, 0x87: 556, 0x88: 333, 0x89: 1000, 0x8a: 667,
  0x8b: 333, 0x8c: 1000, 0x8e: 611, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000,
  0x98: 333, 0x99: 1000, 0x9a: 500, 0x9b: 333, 0x9c: 944, 0x9e: 500, 0x9f: 667,
};

// Letters whose mark is part of the glyph rather than an accent, so Unicode
// does not decompose them: written as the letter they are built on.
const STROKED: Record<string, string> = {
  Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't', Ŀ: 'L', ŀ: 'l',
};

/** A string as Windows-1252 bytes, reduced where a character has no byte. */
export function winAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) bytes.push(0x20);
    else if (code < 0x20) continue;
    else if (code < 0x7f) bytes.push(code);
    else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
    else if (CP1252[code] !== undefined) bytes.push(CP1252[code]!);
    else if (STROKED[char]) bytes.push(STROKED[char]!.charCodeAt(0));
    else {
      // An accented letter outside Latin-1 becomes its letter; anything else, "?".
      const base = char.normalize('NFD').codePointAt(0)!;
      bytes.push(base >= 0x20 && base < 0x7f ? base : 0x3f);
    }
  }
  return bytes;
}

function byteWidth(byte: number, bold: boolean): number {
  if (byte >= 32 && byte <= 126) return (bold ? HELVETICA_BOLD : HELVETICA)[byte - 32]!;
  if (byte >= 0x80 && byte <= 0x9f) return CP1252_WIDTHS[byte] ?? 556;
  if (byte >= 0xa0) {
    // Latin-1: the width of the letter beneath the accent, where there is one.
    const base = String.fromCharCode(byte).normalize('NFD').charCodeAt(0);
    if (base >= 32 && base <= 126 && base !== byte) return (bold ? HELVETICA_BOLD : HELVETICA)[base - 32]!;
    return 556;
  }
  return 556;
}

/** The width of `text` at `size` points. */
export function textWidth(text: string, size: number, bold = false): number {
  return (winAnsi(text).reduce((sum, byte) => sum + byteWidth(byte, bold), 0) * size) / 1000;
}

/** `text` shortened with an ellipsis to fit `width`. */
export function fitText(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textWidth(text.slice(0, middle) + ellipsis, size, bold) <= width) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? text.slice(0, low).trimEnd() + ellipsis : ellipsis;
}

/** `text` broken into lines no wider than `width`, at word boundaries where possible. */
export function wrapText(text: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = textWidth(word, size, bold) <= width ? word : fitText(word, width, size, bold);
    }
    lines.push(line);
  }
  return lines;
}

/** A PDF literal string: printable bytes as they are, the rest escaped. */
function literal(text: string): string {
  let out = '(';
  for (const byte of winAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

const n = (value: number) => (Math.round(value * 100) / 100).toString();
const colour = (rgb: Rgb) => rgb.map(n).join(' ');

/* -------------------------------------------------------------------------- */
/* Pages and the document                                                     */
/* -------------------------------------------------------------------------- */

interface Page {
  ops: string[];
  links: { x: number; y: number; width: number; height: number; url: string }[];
}

export interface TextStyle {
  size?: number;
  bold?: boolean;
  colour?: Rgb;
  /** Where `x` is: the left edge (default), the right edge, or the centre. */
  align?: 'left' | 'right' | 'center';
}

/**
 * A document of pages, drawn top-down: every `y` here is measured from the top
 * of the page, as layout thinks, and turned into PDF's bottom-up coordinates
 * when drawn.
 */
export class PdfDocument {
  readonly width: number;
  readonly height: number;
  private readonly pages: Page[] = [];
  /** The page drawing goes to. */
  private cursor = 0;

  constructor(private readonly info: { title: string; subject?: string; landscape?: boolean; createdAt?: Date }) {
    // A4.
    this.width = info.landscape ? 841.89 : 595.28;
    this.height = info.landscape ? 595.28 : 841.89;
    this.addPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private get current(): Page {
    return this.pages[this.cursor]!;
  }

  /** Starts a new page and draws on it from now on. */
  addPage(): void {
    this.pages.push({ ops: [], links: [] });
    this.cursor = this.pages.length - 1;
  }

  /** Draws on an earlier page from now on — for footers, once the count is known. */
  goToPage(index: number): void {
    if (index < 0 || index >= this.pages.length) throw new Error(`There is no page ${index + 1}.`);
    this.cursor = index;
  }

  text(value: string, x: number, y: number, style: TextStyle = {}): void {
    const size = style.size ?? 9;
    const bold = style.bold ?? false;
    const width = textWidth(value, size, bold);
    const left = style.align === 'right' ? x - width : style.align === 'center' ? x - width / 2 : x;
    // `y` is the top of the line; the baseline sits about 0.8 of the size below it.
    const baseline = this.height - y - size * 0.8;
    this.current.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${colour(style.colour ?? COLOURS.ink)} rg ${n(left)} ${n(baseline)} Td ${literal(value)} Tj ET`,
    );
  }

  rect(x: number, y: number, width: number, height: number, options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }): void {
    const bottom = this.height - y - height;
    if (options.fill) this.current.ops.push(`${colour(options.fill)} rg ${n(x)} ${n(bottom)} ${n(width)} ${n(height)} re f`);
    if (options.stroke) {
      this.current.ops.push(
        `${colour(options.stroke)} RG ${n(options.lineWidth ?? 0.5)} w ${n(x)} ${n(bottom)} ${n(width)} ${n(height)} re S`,
      );
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { colour?: Rgb; width?: number } = {}): void {
    this.current.ops.push(
      `${colour(options.colour ?? COLOURS.border)} RG ${n(options.width ?? 0.5)} w ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`,
    );
  }

  /** Makes a rectangle of the current page open `url`. */
  link(x: number, y: number, width: number, height: number, url: string): void {
    this.current.links.push({ x, y, width, height, url });
  }

  /** The finished file. */
  build(): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => {
      objects.push(body);
      return objects.length;
    };

    const catalog = add('');
    const pagesId = add('');
    const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const created = this.info.createdAt ?? new Date(0);
    const stamp = created.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const infoId = add(
      `<< /Title ${literal(this.info.title)}${this.info.subject ? ` /Subject ${literal(this.info.subject)}` : ''} /Producer (EPM) /CreationDate (D:${stamp}Z) >>`,
    );

    const pageIds: number[] = [];
    for (const page of this.pages) {
      const content = page.ops.join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const annots = page.links.map((link) =>
        add(
          `<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${n(link.x)} ${n(this.height - link.y - link.height)} ${n(link.x + link.width)} ${n(this.height - link.y)}] /A << /S /URI /URI ${literal(link.url)} >> >>`,
        ),
      );
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentId} 0 R${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(' ')}]` : ''} >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    // Every object's byte offset goes in the cross-reference table; content
    // is Latin-1 throughout, so a character is a byte.
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(out, 'latin1'));
  }
}
