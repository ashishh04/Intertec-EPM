import { inflateRawSync } from 'node:zlib';

import type { CsvRecord } from './csv-parse.js';

/**
 * Reads the first sheet of an `.xlsx` as rows of text — the counterpart of
 * `xlsx.ts`, for the task import, so a file exported as Excel, edited and
 * saved by a spreadsheet can be imported as it is.
 *
 * The same trade as the writer: an `.xlsx` is a ZIP of a few XML files, and
 * the first sheet's cells are all the import needs, so a spreadsheet library
 * would be a large dependency for it. Entries may be stored or deflated
 * (spreadsheets deflate them); strings are shared or inline; a number is
 * written as the spreadsheet holds it, so a date a spreadsheet turned into a
 * date is its serial number (the import reads those). Each record keeps its
 * row number, so problems name the row the spreadsheet shows.
 */

/** Whether the bytes are a ZIP — an `.xlsx` — rather than text. */
export const isZip = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;


function unzip(bytes: Uint8Array): Map<string, () => Buffer> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of the central directory: within the last 64 KB, read backwards.
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65_557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a ZIP');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, () => Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('a damaged ZIP');
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`an unsupported ZIP method (${method})`);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });

/** The text of a string item: its <t> elements, leaving out phonetic runs. */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((match) => decode(match[1] ?? '')).join('');

const attribute = (attributes: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];

/** "AB12" → 27 (0-based column). */
function columnOf(reference: string): number {
  let column = 0;
  for (const char of reference.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

/** The first sheet's rows, as text, each with its row number. */
export function readXlsx(bytes: Uint8Array): CsvRecord[] {
  const entries = unzip(bytes);
  const read = (name: string) => entries.get(name)?.().toString('utf8');

  // The first sheet in the workbook's order, through its relationship.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook ? /<sheet\b([^>]*)\/?>/.exec(workbook)?.[1] : undefined;
  const relId = firstSheet ? attribute(firstSheet, 'r:id') : undefined;
  if (relId && rels) {
    for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      if (attribute(match[1]!, 'Id') !== relId) continue;
      const target = attribute(match[1]!, 'Target') ?? '';
      sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  if (!entries.has(sheetPath)) sheetPath = [...entries.keys()].find((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)) ?? sheetPath;
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('no sheet');

  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((match) => textOf(match[1] ?? ''));

  const records: CsvRecord[] = [];
  let nextRow = 1;
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const line = Number(attribute(row[1]!, 'r') ?? nextRow);
    nextRow = line + 1;
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = attribute(cell[1]!, 'r');
      const column = reference ? columnOf(reference) : nextColumn;
      nextColumn = column + 1;
      const type = attribute(cell[1]!, 't');
      const body = cell[2] ?? '';
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string;
      if (type === 's') text = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') text = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') text = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '';
      else text = decode(value ?? '');
      while (cells.length < column) cells.push('');
      cells[column] = text;
    }
    records.push({ line, cells });
  }
  return records;
}
