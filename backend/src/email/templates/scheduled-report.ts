import { listOf } from '../../lib/i18n.js';
import {
  button,
  escape,
  layout,
  muted,
  paragraph,
  paragraphHtml,
  textBody,
  type EmailLocale,
  type RenderedEmail,
} from './layout.js';

/**
 * A scheduled report (BR-207, BR-208).
 *
 * The figures that matter are in the body, so the report reads on a phone
 * without opening anything; the full report travels as the attached PDF and
 * workbook. Each recipient's copy was rendered with their own access (BR-209),
 * and when that left projects out the email says so — a total that silently
 * covered less than the reader assumed would be worse than none.
 */
export interface ScheduledReportPayload {
  /** Empty when the recipient has no account, and so no name: the greeting is then "Hello,". */
  firstName: string;
  reportName: string;
  /** "Portfolio health — All projects". */
  title: string;
  /** "1 Sep – 30 Sep 2026". */
  periodLabel: string;
  figures: { label: string; value: string }[];
  /** Projects in the report's scope this copy leaves out. */
  excludedProjects: number;
  /** The live dashboard, for someone with an account. */
  url?: string;
  /** The rendered files, attached when the email is sent. */
  artifactIds: string[];
  attachmentNames: string[];
}

export function render(payload: ScheduledReportPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = `${payload.reportName} — ${payload.periodLabel}`;
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const intro = tr('Here is {title} for {period}.', { title: payload.title, period: payload.periodLabel });
  const excluded =
    payload.excludedProjects > 0
      ? tr(
          '{count, plural, one {# project in this report\'s scope is not included, because you do not have access to it.} other {# projects in this report\'s scope are not included, because you do not have access to them.}}',
          { count: payload.excludedProjects },
        )
      : undefined;
  const attached =
    payload.attachmentNames.length > 0 ? tr('Attached: {files}.', { files: listOf(payload.attachmentNames) }) : undefined;
  const why = tr('You receive this because you are a recipient of the scheduled report "{report}".', {
    report: payload.reportName,
  });

  // The space between a figure's label and its value is on the side the value
  // is: the right in English, the left in Arabic.
  const gap = locale.dir === 'rtl' ? '4px 0 4px 12px' : '4px 12px 4px 0';
  const figures = payload.figures
    .map(
      (figure) =>
        `<tr><td style="padding:${gap};color:#667085">${escape(figure.label)}</td>` +
        `<td style="padding:4px 0;font-weight:600">${escape(figure.value)}</td></tr>`,
    )
    .join('');

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(intro) +
      (figures ? paragraphHtml(`<table role="presentation" style="border-collapse:collapse">${figures}</table>`) : '') +
      (excluded ? paragraph(excluded) : '') +
      (attached ? muted(attached) : '') +
      (payload.url ? button(tr('Open the dashboard'), payload.url) : '') +
      muted(why),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      intro,
      '',
      ...payload.figures.map((figure) => `  ${figure.label}: ${figure.value}`),
      '',
      excluded,
      attached,
      payload.url,
      '',
      why,
    ],
    locale,
  );

  return { subject, html, text };
}
