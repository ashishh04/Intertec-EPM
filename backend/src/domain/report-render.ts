import { env } from '../config/env.js';
import { dateOf, intlLocale, isRightToLeft, msg, t, type Conventions, type Language, type ParamValue } from '../lib/i18n.js';
import { COLOURS, PdfDocument, fitText, textWidth, wrapText, type Rgb, type TextStyle } from '../lib/pdf.js';
import { buildWorkbook, type CellValue, type Sheet } from '../lib/xlsx.js';
import type { Dashboard, DashboardId, DashboardSeries, DashboardTable, LinkKind } from './dashboards.js';
import type { EvaluatedMeasure, MeasureUnit, Period } from './measures.js';

/**
 * A report, rendered: a dashboard (or a saved view) as a PDF and as an Excel
 * workbook (BR-208), from the same description the screen draws, so what is
 * sent and what is seen cannot disagree.
 *
 * In its reader's language (BR-604). The document arrives with its words —
 * measure names, titles, notes — already in it; the renderer writes its own
 * (headings, units, dates, "Page 2 of 3") in it too. An Arabic report reads
 * right to left: the PDF's columns run from the right edge, text is set from
 * the right, figures sit on the left of their cells, and tiles, charts and
 * legends run right to left; the workbook opens with column A on the right.
 * English is exactly what it always was.
 */

/** What a report shows, whichever source it came from: a dashboard or a saved view. */
export interface ReportDocument {
  /** For links back into a dashboard; absent for a saved view. */
  dashboardId?: DashboardId;
  scopeName: string;
  period: Period;
  asOf: string | null;
  tiles: string[];
  measures: Record<string, EvaluatedMeasure>;
  tables: DashboardTable[];
  series: DashboardSeries[];
}

export function documentOf(dashboard: Dashboard): ReportDocument {
  return {
    dashboardId: dashboard.id,
    scopeName: dashboard.scope.name,
    period: dashboard.period,
    asOf: dashboard.asOf,
    tiles: dashboard.tiles,
    measures: dashboard.measures,
    tables: dashboard.tables,
    series: dashboard.series,
  };
}

export interface ReportContent {
  title: string;
  subtitle: string;
  /** Who this copy was rendered for, and what their access left out (BR-209). */
  preparedFor: string;
  visibilityNote?: string;
  generatedAt: Date;
  document: ReportDocument;
  /** The reader's language; English when absent. */
  language?: Language;
  /** The reader's calendar and digits, for dates and figures in another language. */
  conventions?: Conventions;
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

const number = (value: number, digits = 1) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);

/**
 * A measure's value as people read it, by its unit — the server's
 * formatMeasure. In another language, with its digits, separators and
 * currency, and its words for the units.
 */
export function formatValue(
  value: number | null | undefined,
  unit: MeasureUnit | undefined,
  language: Language = 'en',
  conventions: Conventions = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (language !== 'en') return localValue(value, unit, language, conventions);
  switch (unit) {
    case 'percent':
      return `${number(value)}%`;
    case 'money':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: env.EPM_CURRENCY, maximumFractionDigits: 0 }).format(value);
    case 'hours':
      return `${number(value)} h`;
    case 'days':
      return `${number(value)} d`;
    case 'perWeek':
      return `${number(value)} / wk`;
    case 'points':
      return `${number(value)} pts`;
    case 'index':
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    default:
      return number(value, 0);
  }
}

function localValue(value: number, unit: MeasureUnit | undefined, language: Language, conventions: Conventions): string {
  const locale = intlLocale(language, conventions);
  const figure = (digits = 1) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  switch (unit) {
    case 'percent':
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100);
    case 'money':
      return new Intl.NumberFormat(locale, { style: 'currency', currency: env.EPM_CURRENCY, maximumFractionDigits: 0 }).format(value);
    case 'hours':
      return t(language, '{value} h', { value: figure() }, conventions);
    case 'days':
      return t(language, '{value} d', { value: figure() }, conventions);
    case 'perWeek':
      return t(language, '{value} / wk', { value: figure() }, conventions);
    case 'points':
      return t(language, '{value} pts', { value: figure() }, conventions);
    case 'index':
      return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    default:
      return figure(0);
  }
}

const HEALTH_WORDS: Record<string, string> = { healthy: msg('Green'), warning: msg('Amber'), critical: msg('Red') };
const NOT_ASSESSED = msg('Not assessed');

/** A health level in words, in `language`; anything else as it is. */
const healthWord = (value: string | number | null, language: Language, conventions: Conventions): string => {
  if (value === null) return t(language, NOT_ASSESSED, undefined, conventions);
  const word = HEALTH_WORDS[String(value)];
  return word ? t(language, word, undefined, conventions) : String(value);
};

/** A unit in words, for the workbook's Unit column in another language; English keeps the unit's key. */
const UNIT_WORDS: Record<MeasureUnit, string> = {
  count: msg('count'),
  percent: msg('percent'),
  hours: msg('hours'),
  money: msg('money'),
  days: msg('days'),
  perWeek: msg('per week'),
  points: msg('points'),
  index: msg('index'),
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cellText(
  value: string | number | null,
  unit: MeasureUnit | undefined,
  key: string,
  language: Language = 'en',
  conventions: Conventions = {},
): string {
  if (key === 'health') return healthWord(value, language, conventions);
  if (typeof value === 'number' || unit) return formatValue(typeof value === 'number' ? value : null, unit, language, conventions);
  if (value === null) return '—';
  // A day in a cell: as it is in English, in the reader's own format otherwise.
  if (language !== 'en' && DAY.test(value)) return day(value, language, conventions);
  return String(value);
}

/** Where a row leads in EPM, for a link in the PDF. */
function linkFor(kind: LinkKind, id: string, document: ReportDocument): string | undefined {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  if (kind === 'work_package') return `${base}/tasks/${id}`;
  if (kind === 'project') return `${base}/projects/${id}`;
  if (!document.dashboardId) return undefined;
  return `${base}/insights/${document.dashboardId}?scope=${kind}:${encodeURIComponent(id)}&from=${document.period.from}&to=${document.period.to}`;
}

/** "14 Sept 2026" in English, as it always was; the reader's calendar, digits and month names otherwise. */
const day = (iso: string, language: Language = 'en', conventions: Conventions = {}) => {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (language === 'en') return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return new Intl.DateTimeFormat(intlLocale(language, conventions), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
};

/** The writing a renderer needs for one reader. */
interface Reader {
  language: Language;
  conventions: Conventions;
  rtl: boolean;
  tr: (source: string, params?: Record<string, ParamValue>) => string;
}

function readerOf(content: ReportContent): Reader {
  const language = content.language ?? 'en';
  const conventions = content.conventions ?? {};
  return {
    language,
    conventions,
    rtl: isRightToLeft(language),
    tr: (source, params) => t(language, source, params, conventions),
  };
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

const MARGIN = 36;

/** The Arabic letter mark Intl puts before Arabic-Indic figures; the PDF's shaping knows RLM, which orders the same. */
const ALM = /؜/g;

export function renderPdf(content: ReportContent): Uint8Array {
  const { document: dashboard } = content;
  const reader = readerOf(content);
  const { language, conventions, rtl, tr } = reader;
  const doc = new PdfDocument({
    title: content.title,
    subject: content.subtitle,
    landscape: true,
    createdAt: content.generatedAt,
  });
  const width = doc.width - MARGIN * 2;
  const bottom = doc.height - MARGIN - 18;
  let y = MARGIN;

  const ensure = (height: number) => {
    if (y + height > bottom) {
      doc.addPage();
      y = MARGIN;
    }
  };

  /** Text from the reading start of a box `boxWidth` wide whose left edge is `left`. */
  const write = (value: string, left: number, boxWidth: number, top: number, style: TextStyle) => {
    if (rtl) doc.text(value.replace(ALM, '‏'), left + boxWidth, top, { ...style, align: 'right', direction: 'rtl' });
    else doc.text(value, left, top, style);
  };
  /** The left edge of a box `boxWidth` wide that starts `offset` into the content, in the reading direction. */
  const from = (offset: number, boxWidth: number) => (rtl ? MARGIN + width - offset - boxWidth : MARGIN + offset);
  const value = (figure: number | null | undefined, unit: MeasureUnit | undefined) => formatValue(figure, unit, language, conventions);

  // Header.
  doc.rect(from(0, 40), y, 40, 3, { fill: COLOURS.brand });
  y += 10;
  write(content.title, MARGIN, width, y, { size: 17, bold: true });
  y += 24;
  for (const line of wrapText(content.subtitle, width, 9)) {
    write(line, MARGIN, width, y, { size: 9, colour: COLOURS.muted });
    y += 12;
  }
  write(content.preparedFor, MARGIN, width, y, { size: 9, colour: COLOURS.muted });
  y += 12;
  if (content.visibilityNote) {
    for (const line of wrapText(content.visibilityNote, width, 8.5)) {
      write(line, MARGIN, width, y, { size: 8.5, colour: COLOURS.warning });
      y += 11;
    }
  }
  y += 10;

  // Tiles, up to six to a row, from the reading start.
  const tiles = dashboard.tiles.map((id) => dashboard.measures[id]).filter((m): m is EvaluatedMeasure => Boolean(m));
  const perRow = Math.min(6, Math.max(tiles.length, 1));
  const gap = 8;
  const tileWidth = (width - gap * (perRow - 1)) / perRow;
  for (let index = 0; index < tiles.length; index += perRow) {
    ensure(70);
    tiles.slice(index, index + perRow).forEach((measure, column) => {
      const x = from(column * (tileWidth + gap), tileWidth);
      doc.rect(x, y, tileWidth, 62, { stroke: COLOURS.border, fill: COLOURS.white });
      write(fitText(measure.label.toUpperCase(), tileWidth - 16, 6.5, true), x + 8, tileWidth - 16, y + 8, {
        size: 6.5,
        bold: true,
        colour: COLOURS.muted,
      });
      write(fitText(value(measure.value, measure.unit), tileWidth - 16, 15, true), x + 8, tileWidth - 16, y + 21, {
        size: 15,
        bold: true,
        colour: measure.value === null ? COLOURS.faint : COLOURS.brand,
      });
      if (measure.note) {
        wrapText(measure.note, tileWidth - 16, 6.5)
          .slice(0, 2)
          .forEach((line, row) => write(line, x + 8, tileWidth - 16, y + 42 + row * 8, { size: 6.5, colour: COLOURS.muted }));
      }
    });
    y += 70;
  }
  y += 6;

  // Series, two to a row: bars, or lines where several share the axes. Time
  // runs in the reading direction: right to left in Arabic.
  const chartWidth = (width - 12) / 2;
  const LINE_COLOURS: Rgb[] = [COLOURS.brand, COLOURS.success, COLOURS.warning];
  for (let index = 0; index < dashboard.series.length; index += 2) {
    ensure(150);
    dashboard.series.slice(index, index + 2).forEach((series, column) => {
      const x = from(column * (chartWidth + 12), chartWidth);
      const unit = dashboard.measures[series.measureId]?.unit;
      write(series.title, x, chartWidth, y, { size: 10, bold: true });
      write(series.bucket === 'week' ? tr('By week') : tr('By month'), x, chartWidth, y + 13, { size: 7.5, colour: COLOURS.muted });
      const top = y + 28;
      const height = 100;
      /** The first and last buckets' dates, under the start and the end of the axis. */
      const ends = () => {
        const first = series.points[0];
        const last = series.points[series.points.length - 1];
        if (rtl) {
          const style: TextStyle = { size: 6.5, colour: COLOURS.muted, direction: 'rtl' };
          if (first) doc.text(day(first.from, language, conventions), x + chartWidth, top + height + 4, { ...style, align: 'right' });
          if (last && last !== first) doc.text(day(last.from, language, conventions), x, top + height + 4, style);
          return;
        }
        if (first) doc.text(day(first.from), x, top + height + 4, { size: 6.5, colour: COLOURS.muted });
        if (last && last !== first) doc.text(day(last.from), x + chartWidth, top + height + 4, { size: 6.5, colour: COLOURS.muted, align: 'right' });
      };
      if (series.lines?.length) {
        const all = [{ label: series.label ?? series.title, points: series.points }, ...series.lines];
        const max = Math.max(...all.flatMap((line) => line.points.map((point) => point.value ?? 0)), 0) || 1;
        doc.line(x, top + height, x + chartWidth, top + height, { colour: COLOURS.border });
        write(value(max, unit), x, chartWidth, top - 2, { size: 6.5, colour: COLOURS.faint });
        const step = chartWidth / Math.max(series.points.length - 1, 1);
        const at = (n: number) => (rtl ? x + chartWidth - n * step : x + n * step);
        const slot = chartWidth / all.length;
        all.forEach((line, position) => {
          const colour = LINE_COLOURS[position % LINE_COLOURS.length]!;
          line.points.forEach((point, n) => {
            const next = line.points[n + 1];
            if (point.value === null || !next || next.value === null) return;
            const y1 = top + height - (point.value / max) * (height - 10);
            const y2 = top + height - (next.value / max) * (height - 10);
            doc.line(at(n), y1, at(n + 1), y2, { colour, width: 1.2 });
          });
          // The legend: a swatch, then the line's name, from the reading start.
          if (rtl) {
            const right = x + chartWidth - position * slot;
            doc.rect(right - 6, top + height + 14, 6, 3, { fill: colour });
            doc.text(fitText(line.label, slot - 10, 6.5), right - 9, top + height + 12, {
              size: 6.5,
              colour: COLOURS.muted,
              align: 'right',
              direction: 'rtl',
            });
            return;
          }
          doc.rect(x + position * slot, top + height + 14, 6, 3, { fill: colour });
          doc.text(fitText(line.label, slot - 10, 6.5), x + position * slot + 9, top + height + 12, {
            size: 6.5,
            colour: COLOURS.muted,
          });
        });
        ends();
        return;
      }
      const values = series.points.map((point) => point.value ?? 0);
      const max = Math.max(...values, 0) || 1;
      doc.line(x, top + height, x + chartWidth, top + height, { colour: COLOURS.border });
      write(value(max, unit), x, chartWidth, top - 2, { size: 6.5, colour: COLOURS.faint });
      const slot = chartWidth / Math.max(series.points.length, 1);
      series.points.forEach((point, at) => {
        const barHeight = point.value === null ? 0 : (point.value / max) * (height - 10);
        if (barHeight > 0) {
          const left = rtl ? x + chartWidth - (at + 1) * slot + slot * 0.2 : x + at * slot + slot * 0.2;
          doc.rect(left, top + height - barHeight, slot * 0.6, barHeight, { fill: COLOURS.brand });
        }
      });
      ends();
    });
    y += 150;
  }

  // Tables.
  for (const table of dashboard.tables) renderTable(doc, table, dashboard, () => y, (next) => (y = next), ensure, width, reader);

  // Definitions: the name on the reading side, what it counts beside it.
  ensure(40);
  y += 6;
  write(tr('How these are counted'), MARGIN, width, y, { size: 11, bold: true });
  y += 16;
  for (const measure of tiles) {
    const lines = wrapText(measure.definition, width - 150, 7.5);
    ensure(lines.length * 10 + 4);
    write(fitText(measure.label, 140, 7.5, true), from(0, 140), 140, y, { size: 7.5, bold: true });
    lines.forEach((line, row) => write(line, from(150, width - 150), width - 150, y + row * 10, { size: 7.5, colour: COLOURS.muted }));
    y += lines.length * 10 + 4;
  }

  // Footers, now that the number of pages is known: what this is on the
  // reading side, the page number on the other.
  const time = content.generatedAt.toISOString().slice(0, 16).replace('T', ' ');
  const footer = language === 'en' ? `EPM · ${content.title} · ${time} UTC` : tr('EPM · {title} · {time} UTC', { title: content.title, time });
  for (let page = 0; page < doc.pageCount; page += 1) {
    doc.goToPage(page);
    doc.line(MARGIN, doc.height - MARGIN - 8, doc.width - MARGIN, doc.height - MARGIN - 8);
    const pageOf = tr('Page {page} of {count}', { page: page + 1, count: doc.pageCount });
    if (rtl) {
      doc.text(fitText(footer, width - 80, 7), doc.width - MARGIN, doc.height - MARGIN - 4, {
        size: 7,
        colour: COLOURS.faint,
        align: 'right',
        direction: 'rtl',
      });
      doc.text(pageOf, MARGIN, doc.height - MARGIN - 4, { size: 7, colour: COLOURS.faint, direction: 'rtl' });
      continue;
    }
    doc.text(fitText(footer, width - 80, 7), MARGIN, doc.height - MARGIN - 4, {
      size: 7,
      colour: COLOURS.faint,
    });
    doc.text(pageOf, doc.width - MARGIN, doc.height - MARGIN - 4, {
      size: 7,
      colour: COLOURS.faint,
      align: 'right',
    });
  }

  return doc.build();
}

function renderTable(
  doc: PdfDocument,
  table: DashboardTable,
  dashboard: ReportDocument,
  getY: () => number,
  setY: (y: number) => void,
  ensure: (height: number) => void,
  width: number,
  reader: Reader,
): void {
  const { language, conventions, rtl, tr } = reader;
  const columns = table.columns;
  const numeric = columns.map((column, index) => index > 0 && Boolean(column.unit));
  // The first column takes what the others leave, and at least a third — a
  // quarter in a wide table, so eight figures still fit beside it.
  const rest = columns.length - 1;
  const firstWidth = Math.max(rest >= 7 ? width / 4 : width / 3, width - rest * 92);
  const otherWidth = rest > 0 ? (width - firstWidth) / rest : 0;
  const widths = columns.map((_, index) => (index === 0 ? firstWidth : otherWidth));
  const rowHeight = 15;

  /**
   * Where a cell's text goes: text from the reading start of the cell, a
   * figure at its end — the right in English, the left in Arabic, where the
   * columns also run from the right edge.
   */
  const place = (left: number, cellWidth: number, isNumber: boolean): { x: number; style: Pick<TextStyle, 'align' | 'direction'> } => {
    if (!rtl) return isNumber ? { x: left + cellWidth - 5, style: { align: 'right' } } : { x: left + 5, style: { align: 'left' } };
    return isNumber ? { x: left + 5, style: { align: 'left', direction: 'rtl' } } : { x: left + cellWidth - 5, style: { align: 'right', direction: 'rtl' } };
  };

  const header = () => {
    let x = rtl ? MARGIN + width : MARGIN;
    doc.rect(MARGIN, getY(), width, rowHeight, { fill: COLOURS.surface });
    columns.forEach((column, index) => {
      const cellWidth = widths[index]!;
      const left = rtl ? x - cellWidth : x;
      const label = fitText(column.label.toUpperCase(), cellWidth - 10, 6.5, true);
      const at = place(left, cellWidth, numeric[index]!);
      doc.text(label, at.x, getY() + 4.5, {
        size: 6.5,
        bold: true,
        colour: COLOURS.muted,
        ...at.style,
      });
      if (rtl) x -= cellWidth;
      else x += cellWidth;
    });
    setY(getY() + rowHeight);
  };

  ensure(40 + rowHeight * Math.min(table.rows.length, 3));
  if (rtl) doc.text(table.title, MARGIN + width, getY() + 6, { size: 11, bold: true, align: 'right', direction: 'rtl' });
  else doc.text(table.title, MARGIN, getY() + 6, { size: 11, bold: true });
  setY(getY() + 24);
  if (table.rows.length === 0) {
    const nothing = tr('Nothing in this scope and period.');
    if (rtl) doc.text(nothing, MARGIN + width, getY(), { size: 8, colour: COLOURS.muted, align: 'right', direction: 'rtl' });
    else doc.text(nothing, MARGIN, getY(), { size: 8, colour: COLOURS.muted });
    setY(getY() + 22);
    return;
  }
  header();

  table.rows.forEach((row, rowIndex) => {
    if (getY() + rowHeight > doc.height - MARGIN - 18) {
      doc.addPage();
      setY(MARGIN);
      header();
    }
    if (rowIndex % 2 === 1) doc.rect(MARGIN, getY(), width, rowHeight, { fill: COLOURS.zebra });
    let x = rtl ? MARGIN + width : MARGIN;
    columns.forEach((column, index) => {
      const cellWidth = widths[index]!;
      const left = rtl ? x - cellWidth : x;
      const raw = row.cells[column.key] ?? null;
      const text = fitText(cellText(raw, column.unit, column.key, language, conventions), cellWidth - 10, 8, index === 0);
      const tone: Rgb =
        column.key === 'health' && raw === 'critical'
          ? COLOURS.danger
          : column.key === 'health' && raw === 'warning'
            ? COLOURS.warning
            : COLOURS.ink;
      const at = place(left, cellWidth, numeric[index]!);
      doc.text(rtl ? text.replace(ALM, '‏') : text, at.x, getY() + 4, {
        size: 8,
        bold: index === 0,
        colour: tone,
        ...at.style,
      });
      const url = index === 0 && row.link ? linkFor(row.link.kind, row.link.id, dashboard) : undefined;
      if (url) {
        const linkWidth = Math.min(textWidth(text, 8, true), widths[0]! - 10);
        doc.link(rtl ? left + cellWidth - 5 - linkWidth : x + 5, getY() + 2, linkWidth, rowHeight - 4, url);
      }
      if (rtl) x -= cellWidth;
      else x += cellWidth;
    });
    setY(getY() + rowHeight);
  });
  doc.line(MARGIN, getY(), MARGIN + width, getY());
  setY(getY() + 16);
}

/* -------------------------------------------------------------------------- */
/* Excel                                                                      */
/* -------------------------------------------------------------------------- */

export function renderXlsx(content: ReportContent): Uint8Array {
  const { document: dashboard } = content;
  const { language, conventions, rtl, tr } = readerOf(content);
  // English has always written the period's days as 2026-09-01.
  const when = (iso: string): ParamValue => (language === 'en' ? iso : dateOf(iso));
  const about: Sheet = {
    name: tr('About'),
    headers: ['', ''],
    rows: [
      [tr('Report'), content.title],
      [tr('Period'), tr('{from} to {to}', { from: when(dashboard.period.from), to: when(dashboard.period.to) })],
      [tr('Scope'), dashboard.scopeName],
      [tr('Data as of'), dashboard.asOf ?? ''],
      [tr('Prepared'), content.preparedFor],
      ...(content.visibilityNote ? [[tr('Access'), content.visibilityNote] as CellValue[]] : []),
      [tr('Generated'), content.generatedAt.toISOString()],
    ],
    widths: [16, 90],
  };

  const summary: Sheet = {
    name: tr('Summary'),
    headers: [tr('Measure'), tr('Value'), tr('Unit'), tr('Note'), tr('Definition')],
    rows: dashboard.tiles
      .map((id) => dashboard.measures[id])
      .filter((m): m is EvaluatedMeasure => Boolean(m))
      .map((measure) => [
        measure.label,
        measure.value,
        language === 'en' ? measure.unit : tr(UNIT_WORDS[measure.unit]),
        measure.note ?? '',
        measure.definition,
      ]),
    widths: [24, 14, 10, 40, 90],
  };

  const tables: Sheet[] = dashboard.tables.map((table) => ({
    name: table.title,
    headers: table.columns.map((column) => column.label),
    rows: table.rows.map((row) =>
      table.columns.map((column) => {
        const value = row.cells[column.key] ?? null;
        if (column.key === 'health') return healthWord(value, language, conventions);
        return value;
      }),
    ),
  }));

  const trends: Sheet[] =
    dashboard.series.length > 0
      ? [
          {
            name: tr('Trends'),
            headers: [
              tr('From'),
              tr('To'),
              ...dashboard.series.flatMap((series) => (series.lines?.length ? [series.label ?? series.title, ...series.lines.map((line) => line.label)] : [series.title])),
            ],
            rows: (dashboard.series[0]?.points ?? []).map((point, index) => [
              point.from,
              point.to,
              ...dashboard.series.flatMap((series) => [series.points[index]?.value ?? null, ...(series.lines ?? []).map((line) => line.points[index]?.value ?? null)]),
            ]),
          },
        ]
      : [];

  return buildWorkbook([about, summary, ...tables, ...trends], rtl ? { title: content.title, rightToLeft: true } : { title: content.title });
}
