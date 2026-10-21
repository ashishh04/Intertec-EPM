import type { CsvRecord } from '../lib/csv-parse.js';

/**
 * Files from OpenProject's own export, read as the import's columns.
 *
 * EPM's tasks are OpenProject's work packages, so a sheet exported there names
 * the same tasks and can update them as EPM's own export does. Its layout
 * differs, and is translated here before anything is checked:
 *
 * - `id` 801 is the task WP801; `Parent` "Summary task #812: Name" is WP812.
 * - `% Complete` is a fraction (0.6) and becomes 60; `Work` is the estimate in
 *   hours; `Finish date` the due date; `Target versions` the version.
 * - Dates follow the exporting user's format — 09/02/2026 is 2 September for
 *   one and 9 February for another — so the order is worked out from the file:
 *   a first part over 12 means day first, a second part over 12 month first,
 *   dots day first; otherwise month first, OpenProject's default.
 * - The XLS export "with relations" repeats a task once for each relation:
 *   those rows are merged, and Precedes and Follows become Predecessors.
 *
 * Other columns pass through under their own names — custom fields are matched
 * by name later — and those the import has no use for are reported as ignored.
 */

export interface SourceInfo {
  format: 'epm' | 'openproject';
  /** How the file's dates were read, when they were not written year first. */
  dateOrder?: 'day-first' | 'month-first';
}

const normal = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** OpenProject's names for the import's columns. */
const RENAME: Record<string, string> = {
  id: 'ID',
  parent: 'Parent ID',
  'finish date': 'Due date',
  work: 'Estimated hours',
  complete: 'Done %',
  'target versions': 'Version',
  'target version': 'Version',
  version: 'Version',
  'story points': 'Story points',
  // Its own sprint board, not EPM's sprints (versions): kept out of the Version column.
  sprint: 'Sprint (not imported)',
};

const DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T].*)?$/;

function isOpenProject(header: string[]): boolean {
  const names = new Set(header.map(normal));
  return (names.has('created on') && names.has('updated on')) || (names.has('author') && names.has('accountable'));
}

/** Reads a file as the import's columns: EPM's own sheets as they are, OpenProject's translated. */
export function normaliseSource(input: CsvRecord[]): { records: CsvRecord[]; source: SourceInfo } {
  // The header: the first row with a Subject in it (the relations export puts a title row above).
  const headerAt = input.slice(0, 5).findIndex((record) => record.cells.some((cell) => normal(cell) === 'subject'));
  if (headerAt < 0 || !isOpenProject(input[headerAt]!.cells)) return { records: input, source: { format: 'epm' } };

  const header = input[headerAt]!.cells;
  const names = header.map(normal);
  const relationAt = names.indexOf('relation type');
  // The relations export starts each row with an empty column, and has another before its relations.
  let end = relationAt >= 0 ? relationAt : header.length;
  const start = names.findIndex((name, at) => at < end && name !== '');
  while (end > start + 1 && names[end - 1] === '') end -= 1;
  const columns = header.slice(start, end);
  const keyAt = columns.findIndex((name) => normal(name) === 'id');
  const relatedAt = relationAt >= 0 ? names.findIndex((name, at) => at > relationAt && name === 'id') : -1;
  const body = input.slice(headerAt + 1);

  // The order of the file's dates, from every date in it.
  let dayFirst = false;
  let monthFirst = false;
  let dots = false;
  for (const record of body) {
    for (const cell of record.cells.slice(start, end)) {
      const match = DATE.exec(cell.trim());
      if (!match) continue;
      if (Number(match[1]) > 12) dayFirst = true;
      if (Number(match[3]) > 12) monthFirst = true;
      if (match[2] === '.') dots = true;
    }
  }
  const order: SourceInfo['dateOrder'] = dayFirst && !monthFirst ? 'day-first' : monthFirst ? 'month-first' : dots ? 'day-first' : 'month-first';
  const iso = (cell: string) => {
    const match = DATE.exec(cell.trim());
    if (!match) return cell;
    const [first, second, year] = [Number(match[1]), Number(match[3]), match[4]];
    const [month, day] = order === 'day-first' ? [second, first] : [first, second];
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  // A column is a date column when every value in it is a date.
  const dateColumns = new Set(
    columns
      .map((_, at) => at)
      .filter((at) => {
        const values = body.map((record) => (record.cells[start + at] ?? '').trim()).filter(Boolean);
        return values.length > 0 && values.every((value) => DATE.test(value));
      }),
  );

  const renamed = columns.map((name) => RENAME[normal(name)] ?? name);
  const doneAt = renamed.indexOf('Done %');
  const parentAt = renamed.indexOf('Parent ID');
  const rows = new Map<string, { line: number; cells: string[] }>();
  const predecessors = new Map<string, Set<string>>();
  const follow = (successor: string, predecessor: string) => predecessors.set(successor, (predecessors.get(successor) ?? new Set()).add(predecessor));
  let unnamed = 0;
  for (const record of body) {
    const cells = columns.map((_, at) => (record.cells[start + at] ?? '').trim());
    if (!cells.some(Boolean)) continue;
    const id = /^\d+$/.test(cells[keyAt] ?? '') ? `WP${cells[keyAt]}` : '';
    if (relatedAt >= 0) {
      const related = (record.cells[relatedAt] ?? '').trim();
      const kind = normal(record.cells[relationAt] ?? '');
      if (id && /^\d+$/.test(related)) {
        if (kind === 'follows') follow(id, `WP${related}`);
        else if (kind === 'precedes') follow(`WP${related}`, id);
      }
    }
    const key = id || `#unnamed${(unnamed += 1)}`;
    if (rows.has(key)) continue;
    const converted = cells.map((cell, at) => (dateColumns.has(at) ? iso(cell) : cell));
    if (keyAt >= 0) converted[keyAt] = id;
    if (parentAt >= 0) {
      const parent = /#(\d+)/.exec(converted[parentAt] ?? '');
      converted[parentAt] = parent ? `WP${parent[1]}` : '';
    }
    if (doneAt >= 0 && converted[doneAt]) {
      const fraction = Number(converted[doneAt]);
      if (Number.isFinite(fraction)) converted[doneAt] = String(Math.round(fraction * 100));
    }
    rows.set(key, { line: record.line, cells: converted });
  }

  const outHeader = relatedAt >= 0 ? [...renamed, 'Predecessors'] : renamed;
  const records: CsvRecord[] = [
    { line: input[headerAt]!.line, cells: outHeader },
    ...[...rows.entries()].map(([key, row]) => ({
      line: row.line,
      cells: relatedAt >= 0 ? [...row.cells, [...(predecessors.get(key) ?? [])].join(';')] : row.cells,
    })),
  ];
  return { records, source: { format: 'openproject', ...(dateColumns.size > 0 ? { dateOrder: order } : {}) } };
}
