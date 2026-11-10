/**
 * Reads a CSV file as spreadsheets write it (RFC 4180): fields in double
 * quotes may hold the separator, line breaks and doubled quotes; a leading
 * byte-order mark (Excel's UTF-8) is dropped; the separator — comma,
 * semicolon (Excel in many locales) or tab — is taken from the header line.
 * Each record keeps the line it started on, so problems can name it.
 */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/** What Windows-1252 has at 0x80–0x9F, where ISO-8859-1 has control characters. */
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * A text file's bytes as text: UTF-8 with or without a byte-order mark; UTF-16
 * with one, as Excel's "Unicode Text" writes it; anything else that is not
 * UTF-8 as Windows-1252, the code page Excel's plain "CSV" save uses on
 * Windows — read as UTF-8 its dashes, ellipses and quotes would each become �.
 * (Node's own decoder for that name is ISO-8859-1, which has none of them.)
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH[byte - 0x80]! : byte);
    return text;
  }
}

export function detectSeparator(text: string): ',' | ';' | '\t' {
  const header = text.slice(0, Math.max(0, text.indexOf('\n')) || text.length);
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let quoted = false;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char as ',' | ';' | '\t'] += 1;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] as ',' | ';' | '\t') ?? ',';
}

export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = detectSeparator(text);
  return unpacked(read(text, separator), separator);
}

function read(text: string, separator: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === separator) {
      cells.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      cells.push(field);
      if (cells.some((cell) => cell.trim() !== '')) records.push({ line: startLine, cells });
      cells = [];
      field = '';
      line += 1;
      startLine = line;
    } else {
      field += char;
    }
  }
  cells.push(field);
  if (cells.some((cell) => cell.trim() !== '')) records.push({ line: startLine, cells });
  return records;
}

/**
 * A tab-separated sheet that a spreadsheet opened as CSV and saved again: each
 * line went into one row split only at its commas — tabs and all — and the
 * save quoted the pieces and padded every row to the widest. Its header's
 * first cell holds tabs, which a real header never does. The pieces joined
 * back at the separator they were split at are the original lines, read again
 * as the tab-separated sheet they are; each record keeps its line in the file.
 */
function unpacked(records: CsvRecord[], separator: string): CsvRecord[] {
  if (separator === '\t' || !(records[0]?.cells[0] ?? '').includes('\t')) return records;
  let text = '';
  let line = 1;
  for (const record of records) {
    for (; line < record.line; line += 1) text += '\n';
    const cells = [...record.cells];
    while (cells.length > 1 && cells.at(-1) === '') cells.pop();
    const joined = cells.join(separator);
    text += joined;
    line += joined.split('\n').length - 1;
  }
  return read(text, '\t');
}

/** A value made safe for a CSV cell, including against formula injection in spreadsheets. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
