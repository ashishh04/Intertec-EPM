import { intlLocale, isRightToLeft, t, type Conventions, type Language } from '../lib/i18n.js';
import { COLOURS, PdfDocument, fitText, type Rgb } from '../lib/pdf.js';
import type { EpmTask } from '../types/epm.js';

/**
 * A project's schedule as a PDF: each task on its row with its key, title,
 * start and finish, and a bar on a time scale — months, or weeks for a short
 * range — with milestones as markers and a line for today. A4 landscape,
 * paginated with the headings repeated. The delivery system's own Gantt PDF
 * export is in its paid editions only.
 */

const MARGIN = 28;
const ROW = 15;
const SCALE = 18;
const DAY = 86_400_000;

interface Column {
  x: number;
  width: number;
}

const COLUMNS = {
  key: { x: MARGIN, width: 58 },
  subject: { x: MARGIN + 60, width: 196 },
  start: { x: MARGIN + 258, width: 52 },
  finish: { x: MARGIN + 312, width: 52 },
} satisfies Record<string, Column>;
const CHART_X = MARGIN + 368;

const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** The range the chart spans: the work's dates, a little either side, never less than four weeks. */
export function ganttRange(tasks: EpmTask[], today: string): { from: string; to: string } {
  const days = tasks.flatMap((task) => [task.startDate, task.dueDate].filter((value): value is string => Boolean(value))).map(dayOf);
  const first = days.length ? Math.min(...days) : dayOf(today);
  const last = days.length ? Math.max(...days) : dayOf(today) + 28 * DAY;
  const from = first - 3 * DAY;
  const to = Math.max(last + 3 * DAY, from + 28 * DAY);
  return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) };
}

export interface GanttInput {
  projectName: string;
  tasks: EpmTask[];
  from: string;
  to: string;
  today: string;
  generatedAt: Date;
  language: Language;
  conventions?: Conventions;
}

export function renderGanttPdf(input: GanttInput): Uint8Array {
  const { language } = input;
  const locale = intlLocale(language, input.conventions);
  const rtl = isRightToLeft(language);
  const short = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const month = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const full = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmt = (iso?: string) => (iso ? short.format(new Date(dayOf(iso))) : '—');

  const doc = new PdfDocument({
    title: t(language, '{project} · Gantt chart', { project: input.projectName }),
    landscape: true,
    createdAt: input.generatedAt,
  });
  const chartWidth = doc.width - MARGIN - CHART_X;
  const from = dayOf(input.from);
  const to = dayOf(input.to) + DAY;
  const span = to - from;
  const xOf = (time: number) => CHART_X + ((Math.min(Math.max(time, from), to) - from) / span) * chartWidth;
  const weeks = span <= 10 * 7 * DAY;

  // Dated work first, by start, then the rest as listed.
  const dated = input.tasks
    .filter((task) => task.startDate || task.dueDate)
    .sort((a, b) => (a.startDate ?? a.dueDate ?? '').localeCompare(b.startDate ?? b.dueDate ?? '') || Number(a.id) - Number(b.id));
  const undated = input.tasks.filter((task) => !task.startDate && !task.dueDate);
  const rows = [...dated, ...undated];

  const top = MARGIN + 44;
  const perPage = Math.max(1, Math.floor((doc.height - MARGIN - 18 - (top + SCALE)) / ROW));
  const pages = Math.max(1, Math.ceil(rows.length / perPage));

  for (let page = 0; page < pages; page += 1) {
    if (page > 0) doc.addPage();

    // Title.
    doc.text(fitText(t(language, '{project} · Gantt chart', { project: input.projectName }), doc.width - MARGIN * 2, 14, true), MARGIN, MARGIN, { size: 14, bold: true });
    doc.text(
      t(language, '{from} to {to} · {count, plural, one {# task} other {# tasks}} · made {made}', {
        from: full.format(new Date(from)),
        to: full.format(new Date(to - DAY)),
        count: rows.length,
        made: full.format(input.generatedAt),
      }),
      MARGIN,
      MARGIN + 20,
      { size: 8, colour: COLOURS.muted },
    );

    // Column headings and the time scale.
    doc.rect(MARGIN, top, doc.width - MARGIN * 2, SCALE, { fill: COLOURS.surface });
    const heading = (label: string, column: Column) => doc.text(fitText(label, column.width - 4, 7, true), column.x + 2, top + 5, { size: 7, bold: true, colour: COLOURS.muted });
    heading(t(language, 'Key'), COLUMNS.key);
    heading(t(language, 'Task'), COLUMNS.subject);
    heading(t(language, 'Start'), COLUMNS.start);
    heading(t(language, 'Finish'), COLUMNS.finish);

    const ticks: { at: number; label: string }[] = [];
    if (weeks) {
      // Mondays.
      let tick = from + ((8 - new Date(from).getUTCDay()) % 7) * DAY;
      for (; tick < to; tick += 7 * DAY) ticks.push({ at: tick, label: short.format(new Date(tick)) });
    } else {
      const start = new Date(from);
      let tick = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (start.getUTCDate() > 1 ? 1 : 0), 1);
      for (; tick < to; tick = Date.UTC(new Date(tick).getUTCFullYear(), new Date(tick).getUTCMonth() + 1, 1)) {
        ticks.push({ at: tick, label: month.format(new Date(tick)) });
      }
    }
    const bottom = top + SCALE + perPage * ROW;
    for (const tick of ticks) {
      const x = xOf(tick.at);
      doc.line(x, top, x, bottom, { colour: COLOURS.border, width: 0.5 });
      if (x + 30 <= doc.width - MARGIN) doc.text(tick.label, x + 2, top + 5, { size: 6.5, colour: COLOURS.muted });
    }

    // Rows.
    const slice = rows.slice(page * perPage, (page + 1) * perPage);
    slice.forEach((task, index) => {
      const y = top + SCALE + index * ROW;
      if (index % 2 === 1) doc.rect(MARGIN, y, doc.width - MARGIN * 2, ROW, { fill: COLOURS.zebra });
      const closed = task.status.isClosed;
      const textColour = closed ? COLOURS.faint : COLOURS.ink;
      doc.text(fitText(task.key, COLUMNS.key.width - 4, 7), COLUMNS.key.x + 2, y + 4, { size: 7, colour: COLOURS.muted });
      doc.text(fitText(task.subject, COLUMNS.subject.width - 4, 7.5), COLUMNS.subject.x + 2, y + 3.5, { size: 7.5, colour: textColour, direction: rtl ? 'rtl' : undefined });
      doc.text(fmt(task.startDate), COLUMNS.start.x + 2, y + 4, { size: 7, colour: COLOURS.muted });
      doc.text(fmt(task.dueDate), COLUMNS.finish.x + 2, y + 4, { size: 7, colour: COLOURS.muted });

      const start = task.startDate ?? task.dueDate;
      const end = task.dueDate ?? task.startDate;
      if (!start || !end) return;
      if (task.type === 'milestone') {
        const x = xOf(dayOf(end) + DAY / 2);
        doc.rect(x - 3.5, y + 4, 7, 7, { fill: COLOURS.warning });
        return;
      }
      const x1 = xOf(dayOf(start));
      const x2 = Math.max(xOf(dayOf(end) + DAY), x1 + 2);
      const overdue = !closed && dayOf(end) < dayOf(input.today);
      const fill: Rgb = closed ? COLOURS.success : overdue ? COLOURS.danger : COLOURS.brand;
      const soft: Rgb = closed ? [0.82, 0.93, 0.86] : overdue ? [0.98, 0.86, 0.86] : COLOURS.brandSoft;
      doc.rect(x1, y + 4, x2 - x1, 7, { fill: soft });
      const done = Math.min(Math.max(task.progress ?? 0, 0), 100);
      if (done > 0) doc.rect(x1, y + 4, ((x2 - x1) * done) / 100, 7, { fill });
      doc.rect(x1, y + 4, x2 - x1, 7, { stroke: fill, lineWidth: 0.5 });
    });

    // Today.
    const now = dayOf(input.today);
    if (now >= from && now < to) {
      const x = xOf(now + DAY / 2);
      doc.line(x, top, x, bottom, { colour: COLOURS.danger, width: 0.75 });
    }
  }

  // Footers, once the count is known.
  for (let page = 0; page < pages; page += 1) {
    doc.goToPage(page);
    doc.text(t(language, 'Page {page, number} of {pages, number}', { page: page + 1, pages }), doc.width - MARGIN, doc.height - MARGIN - 6, {
      size: 7,
      colour: COLOURS.faint,
      align: 'right',
    });
    doc.text(t(language, 'Bars show progress; a square is a milestone; the red line is today.'), MARGIN, doc.height - MARGIN - 6, { size: 7, colour: COLOURS.faint });
  }
  return doc.build();
}
