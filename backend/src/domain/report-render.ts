import { env } from '../config/env.js';
import { COLOURS, PdfDocument, fitText, textWidth, wrapText, type Rgb } from '../lib/pdf.js';
import { buildWorkbook, type CellValue, type Sheet } from '../lib/xlsx.js';
import type { Dashboard, DashboardId, DashboardSeries, DashboardTable, LinkKind } from './dashboards.js';
import type { EvaluatedMeasure, MeasureUnit, Period } from './measures.js';

/**
 * A report, rendered: a dashboard (or a saved view) as a PDF and as an Excel
 * workbook (BR-208), from the same description the screen draws, so what is
 * sent and what is seen cannot disagree.
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
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

const number = (value: number, digits = 1) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);

/** A measure's value as people read it, by its unit — the server's formatMeasure. */
export function formatValue(value: number | null | undefined, unit: MeasureUnit | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
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
    default:
      return number(value, 0);
  }
}

const HEALTH_WORDS: Record<string, string> = { healthy: 'Green', warning: 'Amber', critical: 'Red' };

function cellText(value: string | number | null, unit: MeasureUnit | undefined, key: string): string {
  if (key === 'health') return value === null ? 'Not assessed' : (HEALTH_WORDS[String(value)] ?? String(value));
  if (typeof value === 'number' || unit) return formatValue(typeof value === 'number' ? value : null, unit);
  return value === null ? '—' : String(value);
}

/** Where a row leads in EPM, for a link in the PDF. */
function linkFor(kind: LinkKind, id: string, document: ReportDocument): string | undefined {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  if (kind === 'work_package') return `${base}/tasks/${id}`;
  if (kind === 'project') return `${base}/projects/${id}`;
  if (!document.dashboardId) return undefined;
  return `${base}/insights/${document.dashboardId}?scope=${kind}:${encodeURIComponent(id)}&from=${document.period.from}&to=${document.period.to}`;
}

const day = (iso: string) => {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

const MARGIN = 36;

export function renderPdf(content: ReportContent): Uint8Array {
  const { document: dashboard } = content;
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

  // Header.
  doc.rect(MARGIN, y, 40, 3, { fill: COLOURS.brand });
  y += 10;
  doc.text(content.title, MARGIN, y, { size: 17, bold: true });
  y += 24;
  for (const line of wrapText(content.subtitle, width, 9)) {
    doc.text(line, MARGIN, y, { size: 9, colour: COLOURS.muted });
    y += 12;
  }
  doc.text(content.preparedFor, MARGIN, y, { size: 9, colour: COLOURS.muted });
  y += 12;
  if (content.visibilityNote) {
    for (const line of wrapText(content.visibilityNote, width, 8.5)) {
      doc.text(line, MARGIN, y, { size: 8.5, colour: COLOURS.warning });
      y += 11;
    }
  }
  y += 10;

  // Tiles, up to six to a row.
  const tiles = dashboard.tiles.map((id) => dashboard.measures[id]).filter((m): m is EvaluatedMeasure => Boolean(m));
  const perRow = Math.min(6, Math.max(tiles.length, 1));
  const gap = 8;
  const tileWidth = (width - gap * (perRow - 1)) / perRow;
  for (let index = 0; index < tiles.length; index += perRow) {
    ensure(70);
    tiles.slice(index, index + perRow).forEach((measure, column) => {
      const x = MARGIN + column * (tileWidth + gap);
      doc.rect(x, y, tileWidth, 62, { stroke: COLOURS.border, fill: COLOURS.white });
      doc.text(fitText(measure.label.toUpperCase(), tileWidth - 16, 6.5, true), x + 8, y + 8, {
        size: 6.5,
        bold: true,
        colour: COLOURS.muted,
      });
      doc.text(fitText(formatValue(measure.value, measure.unit), tileWidth - 16, 15, true), x + 8, y + 21, {
        size: 15,
        bold: true,
        colour: measure.value === null ? COLOURS.faint : COLOURS.brand,
      });
      if (measure.note) {
        wrapText(measure.note, tileWidth - 16, 6.5)
          .slice(0, 2)
          .forEach((line, row) => doc.text(line, x + 8, y + 42 + row * 8, { size: 6.5, colour: COLOURS.muted }));
      }
    });
    y += 70;
  }
  y += 6;

  // Series, two to a row, as bars.
  const chartWidth = (width - 12) / 2;
  for (let index = 0; index < dashboard.series.length; index += 2) {
    ensure(150);
    dashboard.series.slice(index, index + 2).forEach((series, column) => {
      const x = MARGIN + column * (chartWidth + 12);
      const unit = dashboard.measures[series.measureId]?.unit;
      doc.text(series.title, x, y, { size: 10, bold: true });
      doc.text(series.bucket === 'week' ? 'By week' : 'By month', x, y + 13, { size: 7.5, colour: COLOURS.muted });
      const top = y + 28;
      const height = 100;
      const values = series.points.map((point) => point.value ?? 0);
      const max = Math.max(...values, 0) || 1;
      doc.line(x, top + height, x + chartWidth, top + height, { colour: COLOURS.border });
      doc.text(formatValue(max, unit), x, top - 2, { size: 6.5, colour: COLOURS.faint });
      const slot = chartWidth / Math.max(series.points.length, 1);
      series.points.forEach((point, at) => {
        const barHeight = point.value === null ? 0 : (point.value / max) * (height - 10);
        if (barHeight > 0) {
          doc.rect(x + at * slot + slot * 0.2, top + height - barHeight, slot * 0.6, barHeight, { fill: COLOURS.brand });
        }
      });
      const first = series.points[0];
      const last = series.points[series.points.length - 1];
      if (first) doc.text(day(first.from), x, top + height + 4, { size: 6.5, colour: COLOURS.muted });
      if (last && last !== first) doc.text(day(last.from), x + chartWidth, top + height + 4, { size: 6.5, colour: COLOURS.muted, align: 'right' });
    });
    y += 150;
  }

  // Tables.
  for (const table of dashboard.tables) renderTable(doc, table, dashboard, () => y, (next) => (y = next), ensure, width);

  // Definitions.
  ensure(40);
  y += 6;
  doc.text('How these are counted', MARGIN, y, { size: 11, bold: true });
  y += 16;
  for (const measure of tiles) {
    const lines = wrapText(measure.definition, width - 150, 7.5);
    ensure(lines.length * 10 + 4);
    doc.text(fitText(measure.label, 140, 7.5, true), MARGIN, y, { size: 7.5, bold: true });
    lines.forEach((line, row) => doc.text(line, MARGIN + 150, y + row * 10, { size: 7.5, colour: COLOURS.muted }));
    y += lines.length * 10 + 4;
  }

  // Footers, now that the number of pages is known.
  const stamp = `${content.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  for (let page = 0; page < doc.pageCount; page += 1) {
    doc.goToPage(page);
    doc.line(MARGIN, doc.height - MARGIN - 8, doc.width - MARGIN, doc.height - MARGIN - 8);
    doc.text(fitText(`EPM · ${content.title} · ${stamp}`, width - 80, 7), MARGIN, doc.height - MARGIN - 4, {
      size: 7,
      colour: COLOURS.faint,
    });
    doc.text(`Page ${page + 1} of ${doc.pageCount}`, doc.width - MARGIN, doc.height - MARGIN - 4, {
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
): void {
  const columns = table.columns;
  const numeric = columns.map((column, index) => index > 0 && Boolean(column.unit));
  // The first column takes what the others leave, and at least a third.
  const rest = columns.length - 1;
  const firstWidth = Math.max(width / 3, width - rest * 92);
  const otherWidth = rest > 0 ? (width - firstWidth) / rest : 0;
  const widths = columns.map((_, index) => (index === 0 ? firstWidth : otherWidth));
  const rowHeight = 15;

  const header = () => {
    let x = MARGIN;
    doc.rect(MARGIN, getY(), width, rowHeight, { fill: COLOURS.surface });
    columns.forEach((column, index) => {
      const label = fitText(column.label.toUpperCase(), widths[index]! - 10, 6.5, true);
      doc.text(label, numeric[index] ? x + widths[index]! - 5 : x + 5, getY() + 4.5, {
        size: 6.5,
        bold: true,
        colour: COLOURS.muted,
        align: numeric[index] ? 'right' : 'left',
      });
      x += widths[index]!;
    });
    setY(getY() + rowHeight);
  };

  ensure(40 + rowHeight * Math.min(table.rows.length, 3));
  doc.text(table.title, MARGIN, getY() + 6, { size: 11, bold: true });
  setY(getY() + 24);
  if (table.rows.length === 0) {
    doc.text('Nothing in this scope and period.', MARGIN, getY(), { size: 8, colour: COLOURS.muted });
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
    let x = MARGIN;
    columns.forEach((column, index) => {
      const raw = row.cells[column.key] ?? null;
      const text = fitText(cellText(raw, column.unit, column.key), widths[index]! - 10, 8, index === 0);
      const tone: Rgb =
        column.key === 'health' && raw === 'critical'
          ? COLOURS.danger
          : column.key === 'health' && raw === 'warning'
            ? COLOURS.warning
            : COLOURS.ink;
      doc.text(text, numeric[index] ? x + widths[index]! - 5 : x + 5, getY() + 4, {
        size: 8,
        bold: index === 0,
        colour: tone,
        align: numeric[index] ? 'right' : 'left',
      });
      const url = index === 0 && row.link ? linkFor(row.link.kind, row.link.id, dashboard) : undefined;
      if (url) doc.link(x + 5, getY() + 2, Math.min(textWidth(text, 8, true), widths[0]! - 10), rowHeight - 4, url);
      x += widths[index]!;
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
  const about: Sheet = {
    name: 'About',
    headers: ['', ''],
    rows: [
      ['Report', content.title],
      ['Period', `${dashboard.period.from} to ${dashboard.period.to}`],
      ['Scope', dashboard.scopeName],
      ['Data as of', dashboard.asOf ?? ''],
      ['Prepared', content.preparedFor],
      ...(content.visibilityNote ? [['Access', content.visibilityNote] as CellValue[]] : []),
      ['Generated', content.generatedAt.toISOString()],
    ],
    widths: [16, 90],
  };

  const summary: Sheet = {
    name: 'Summary',
    headers: ['Measure', 'Value', 'Unit', 'Note', 'Definition'],
    rows: dashboard.tiles
      .map((id) => dashboard.measures[id])
      .filter((m): m is EvaluatedMeasure => Boolean(m))
      .map((measure) => [measure.label, measure.value, measure.unit, measure.note ?? '', measure.definition]),
    widths: [24, 14, 10, 40, 90],
  };

  const tables: Sheet[] = dashboard.tables.map((table) => ({
    name: table.title,
    headers: table.columns.map((column) => column.label),
    rows: table.rows.map((row) =>
      table.columns.map((column) => {
        const value = row.cells[column.key] ?? null;
        if (column.key === 'health') return value === null ? 'Not assessed' : (HEALTH_WORDS[String(value)] ?? String(value));
        return value;
      }),
    ),
  }));

  const trends: Sheet[] =
    dashboard.series.length > 0
      ? [
          {
            name: 'Trends',
            headers: ['From', 'To', ...dashboard.series.map((series) => series.title)],
            rows: (dashboard.series[0]?.points ?? []).map((point, index) => [
              point.from,
              point.to,
              ...dashboard.series.map((series) => series.points[index]?.value ?? null),
            ]),
          },
        ]
      : [];

  return buildWorkbook([about, summary, ...tables, ...trends], { title: content.title });
}
