import type { CsvRecord } from './csv-parse.js';

/**
 * Reads the first sheet of an old binary Excel file (`.xls`, Excel 97–2003,
 * BIFF8) as rows of text — what OpenProject's own "XLS" export writes, so that
 * file can be imported as it is downloaded.
 *
 * An `.xls` is a compound file (a small FAT file system) holding a "Workbook"
 * stream of BIFF records. Only what a sheet of values needs is read: the shared
 * strings, and the cell records — strings, numbers, RK numbers, booleans and
 * formula results. Formatting, formulas themselves and every other sheet are
 * passed over. A spreadsheet library would be a large dependency for this; the
 * same trade as `xlsx-read.ts`.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

/* -------------------------------------------------------------------------- */
/* Compound file                                                              */
/* -------------------------------------------------------------------------- */

function workbookStream(bytes: Buffer): Buffer {
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error('not a compound file');
  const sectorSize = 1 << bytes.readUInt16LE(0x1e);
  const miniSectorSize = 1 << bytes.readUInt16LE(0x20);
  const firstDirectory = bytes.readUInt32LE(0x30);
  const miniCutoff = bytes.readUInt32LE(0x38);
  const firstMiniFat = bytes.readUInt32LE(0x3c);
  let difatSector = bytes.readUInt32LE(0x44);
  const sector = (index: number) => bytes.subarray((index + 1) * sectorSize, (index + 2) * sectorSize);

  // The FAT's own sectors: 109 listed in the header, the rest in a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const value = bytes.readUInt32LE(0x4c + index * 4);
    if (value !== FREE) fatSectors.push(value);
  }
  for (let guard = 0; difatSector !== END_OF_CHAIN && difatSector !== FREE && guard < 10_000; guard += 1) {
    const block = sector(difatSector);
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) {
      const value = block.readUInt32LE(index * 4);
      if (value !== FREE) fatSectors.push(value);
    }
    difatSector = block.readUInt32LE(sectorSize - 4);
  }
  const fat: number[] = [];
  for (const index of fatSectors) {
    const block = sector(index);
    for (let at = 0; at < sectorSize; at += 4) fat.push(block.readUInt32LE(at));
  }
  const chain = (start: number, table: number[], read: (index: number) => Buffer) => {
    const parts: Buffer[] = [];
    for (let at = start, guard = 0; at !== END_OF_CHAIN && at < table.length && guard <= table.length; at = table[at]!, guard += 1) parts.push(read(at));
    return Buffer.concat(parts);
  };

  // The directory: 128-byte entries; the root entry holds the mini stream.
  const directory = chain(firstDirectory, fat, sector);
  let root: { start: number; size: number } | null = null;
  let workbook: { start: number; size: number } | null = null;
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const nameLength = directory.readUInt16LE(at + 64);
    const name = directory.toString('utf16le', at, at + Math.max(0, nameLength - 2));
    const type = directory[at + 66];
    const entry = { start: directory.readUInt32LE(at + 116), size: directory.readUInt32LE(at + 120) };
    if (type === 5) root = entry;
    else if (type === 2 && (name === 'Workbook' || name === 'Book') && !workbook) workbook = entry;
  }
  if (!workbook) throw new Error('no workbook stream');
  if (workbook.size >= miniCutoff) return chain(workbook.start, fat, sector).subarray(0, workbook.size);

  // A small stream lives in the mini stream, in 64-byte sectors of its own FAT.
  const miniStream = chain(root!.start, fat, sector);
  const miniFatBytes = firstMiniFat === END_OF_CHAIN ? Buffer.alloc(0) : chain(firstMiniFat, fat, sector);
  const miniFat: number[] = [];
  for (let at = 0; at + 4 <= miniFatBytes.length; at += 4) miniFat.push(miniFatBytes.readUInt32LE(at));
  return chain(workbook.start, miniFat, (index) => miniStream.subarray(index * miniSectorSize, (index + 1) * miniSectorSize)).subarray(0, workbook.size);
}

/* -------------------------------------------------------------------------- */
/* BIFF8                                                                      */
/* -------------------------------------------------------------------------- */

interface BiffRecord {
  type: number;
  data: Buffer;
  offset: number;
}

function* records(stream: Buffer, from = 0): Generator<BiffRecord> {
  for (let at = from; at + 4 <= stream.length; ) {
    const type = stream.readUInt16LE(at);
    const length = stream.readUInt16LE(at + 2);
    yield { type, data: stream.subarray(at + 4, at + 4 + length), offset: at };
    at += 4 + length;
  }
}

/**
 * Strings that run across a record and its CONTINUE records. Character data
 * split by a CONTINUE starts again with its own flags byte (one or two bytes a
 * character); anything else carries straight on.
 */
class Segments {
  private part = 0;
  private at = 0;
  constructor(private readonly parts: Buffer[]) {}
  private ensure() {
    while (this.part < this.parts.length && this.at >= this.parts[this.part]!.length) {
      this.part += 1;
      this.at = 0;
    }
    if (this.part >= this.parts.length) throw new Error('string past the end of its record');
  }
  u8() {
    this.ensure();
    return this.parts[this.part]![this.at++]!;
  }
  u16() {
    return this.u8() | (this.u8() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(count: number) {
    for (let left = count; left > 0; ) {
      this.ensure();
      const take = Math.min(left, this.parts[this.part]!.length - this.at);
      this.at += take;
      left -= take;
    }
  }
  text(): string {
    const count = this.u16();
    const flags = this.u8();
    let wide = (flags & 0x01) !== 0;
    const runs = flags & 0x08 ? this.u16() : 0;
    const extended = flags & 0x04 ? this.u32() : 0;
    let out = '';
    for (let left = count; left > 0; ) {
      if (this.at >= (this.parts[this.part]?.length ?? 0)) {
        this.part += 1;
        this.at = 0;
        if (this.part >= this.parts.length) throw new Error('string past the end of its record');
        wide = (this.parts[this.part]![this.at++]! & 0x01) !== 0;
      }
      const block = this.parts[this.part]!;
      const fits = Math.min(left, Math.floor((block.length - this.at) / (wide ? 2 : 1)));
      out += wide ? block.toString('utf16le', this.at, this.at + fits * 2) : block.toString('latin1', this.at, this.at + fits);
      this.at += fits * (wide ? 2 : 1);
      left -= fits;
      if (fits === 0) this.at = block.length;
    }
    this.skip(runs * 4 + extended);
    return out;
  }
}

/** An RK number: a packed integer or the high 30 bits of a double, perhaps times 100. */
function rk(value: number): number {
  let number: number;
  if (value & 0x02) number = value >> 2;
  else {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE((value & 0xfffffffc) >>> 0, 4);
    number = bytes.readDoubleLE(0);
  }
  return value & 0x01 ? number / 100 : number;
}

const numberText = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10));

/** Whether the bytes are an old binary Office file — an `.xls`, or another compound document. */
export const isCompoundFile = (bytes: Uint8Array) => SIGNATURE.every((byte, index) => bytes[index] === byte);

/** The first sheet's rows, as text, each with its row number (the first being 1). */
export function readXls(bytes: Uint8Array): CsvRecord[] {
  const stream = workbookStream(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

  // Workbook globals: the shared strings, and where the first sheet starts.
  let shared: string[] = [];
  let firstSheet = -1;
  let sstParts: Buffer[] | null = null;
  const flushSst = () => {
    if (!sstParts) return;
    const reader = new Segments(sstParts);
    reader.skip(4);
    const unique = reader.u32();
    shared = [];
    for (let index = 0; index < unique; index += 1) {
      try {
        shared.push(reader.text());
      } catch {
        break;
      }
    }
    sstParts = null;
  };
  for (const record of records(stream)) {
    if (sstParts && record.type !== 0x003c) flushSst();
    if (record.type === 0x0085 && firstSheet < 0) firstSheet = record.data.readUInt32LE(0);
    else if (record.type === 0x00fc) sstParts = [record.data];
    else if (record.type === 0x003c && sstParts) sstParts.push(record.data);
    else if (record.type === 0x000a) break;
  }
  flushSst();
  if (firstSheet < 0) throw new Error('no sheet');

  const rows = new Map<number, string[]>();
  const put = (row: number, column: number, text: string) => {
    const cells = rows.get(row) ?? [];
    while (cells.length < column) cells.push('');
    cells[column] = text;
    rows.set(row, cells);
  };
  let pendingFormula: { row: number; column: number } | null = null;
  let first = true;
  for (const { type, data } of records(stream, firstSheet)) {
    if (first) {
      first = false;
      if (type !== 0x0809) throw new Error('the sheet does not start where the workbook says');
      continue;
    }
    if (type === 0x000a) break;
    const row = data.length >= 4 ? data.readUInt16LE(0) : 0;
    const column = data.length >= 4 ? data.readUInt16LE(2) : 0;
    switch (type) {
      case 0x00fd: // LABELSST
        put(row, column, shared[data.readUInt32LE(6)] ?? '');
        break;
      case 0x0204: // LABEL
        put(row, column, new Segments([data.subarray(6)]).text());
        break;
      case 0x0203: // NUMBER
        put(row, column, numberText(data.readDoubleLE(6)));
        break;
      case 0x027e: // RK
        put(row, column, numberText(rk(data.readUInt32LE(6))));
        break;
      case 0x00bd: {
        // MULRK: several RK cells in a row
        const last = data.readUInt16LE(data.length - 2);
        for (let at = 4, col = column; col <= last && at + 6 <= data.length - 2; col += 1, at += 6) put(row, col, numberText(rk(data.readUInt32LE(at + 2))));
        break;
      }
      case 0x0205: // BOOLERR
        if (data[7] === 0) put(row, column, data[6] ? 'TRUE' : 'FALSE');
        break;
      case 0x0006: // FORMULA: its cached result
        if (data.readUInt16LE(12) === 0xffff) {
          if (data[6] === 0) pendingFormula = { row, column };
          else if (data[6] === 1) put(row, column, data[8] ? 'TRUE' : 'FALSE');
        } else {
          put(row, column, numberText(data.readDoubleLE(6)));
        }
        break;
      case 0x0207: // STRING: the text result of the formula before it
        if (pendingFormula) {
          put(pendingFormula.row, pendingFormula.column, new Segments([data]).text());
          pendingFormula = null;
        }
        break;
      default:
        break;
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([row, cells]) => ({ line: row + 1, cells }));
}
