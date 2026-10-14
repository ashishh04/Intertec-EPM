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

/** A value made safe for a CSV cell, including against formula injection in spreadsheets. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
