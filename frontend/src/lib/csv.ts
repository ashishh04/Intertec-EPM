/**
 * CSV export, from what is already on screen.
 *
 * The rows a report renders are the rows it exports. That is the point: an
 * export produced by a second query can disagree with the table above it — a
 * different page, a re-run aggregation, a filter applied in one place and not
 * the other — and nobody can tell which one is wrong. Exporting the rendered
 * data cannot drift from it.
 */

/** What a cell may hold. Exported so a page can type its export rows. */
export type CsvValue = string | number | boolean | null | undefined;

/**
 * One field, quoted where it has to be.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab. Excel and Sheets treat
 * such a cell as a formula, so a project called "=SUM(A:A)" — or anything
 * deliberately crafted — would execute on open. The tab makes it text and is
 * invisible in the cell.
 */
function field(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `\t${text}`;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV document from a header row and body rows. */
export function toCsv(headers: CsvValue[], rows: CsvValue[][]): string {
  // CRLF, which is what the spec says and what Excel wants on every platform.
  return [headers, ...rows].map((row) => row.map(field).join(',')).join('\r\n');
}

/**
 * Offers a CSV as a download.
 *
 * The BOM is not decoration: without it Excel on Windows reads the file as the
 * system codepage and mangles every non-ASCII name in it.
 */
export function downloadCsv(filename: string, headers: CsvValue[], rows: CsvValue[][]): void {
  const blob = new Blob([`﻿${toCsv(headers, rows)}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  // Revoked on the next turn of the loop rather than immediately: Safari has
  // not started the download when `click()` returns, and a revoked URL there
  // produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
