import { button, escape, layout, muted, paragraph, paragraphHtml, textBody, type RenderedEmail } from './layout.js';

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
  /** "there" when the recipient has no account, and so no name. */
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

export function render(payload: ScheduledReportPayload): RenderedEmail {
  const subject = `${payload.reportName} — ${payload.periodLabel}`;
  const excluded =
    payload.excludedProjects > 0
      ? `${payload.excludedProjects} ${payload.excludedProjects === 1 ? 'project' : 'projects'} in this report's scope ${payload.excludedProjects === 1 ? 'is' : 'are'} not included, because you do not have access to ${payload.excludedProjects === 1 ? 'it' : 'them'}.`
      : undefined;

  const figures = payload.figures
    .map(
      (figure) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#667085">${escape(figure.label)}</td>` +
        `<td style="padding:4px 0;font-weight:600">${escape(figure.value)}</td></tr>`,
    )
    .join('');

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(`Here is ${payload.title} for ${payload.periodLabel}.`) +
      (figures ? paragraphHtml(`<table role="presentation" style="border-collapse:collapse">${figures}</table>`) : '') +
      (excluded ? paragraph(excluded) : '') +
      (payload.attachmentNames.length > 0
        ? muted(`Attached: ${payload.attachmentNames.join(', ')}.`)
        : '') +
      (payload.url ? button('Open the dashboard', payload.url) : '') +
      muted(`You receive this because you are a recipient of the scheduled report "${payload.reportName}".`),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    `Here is ${payload.title} for ${payload.periodLabel}.`,
    '',
    ...payload.figures.map((figure) => `  ${figure.label}: ${figure.value}`),
    '',
    excluded,
    payload.attachmentNames.length > 0 ? `Attached: ${payload.attachmentNames.join(', ')}.` : undefined,
    payload.url,
    '',
    `You receive this because you are a recipient of the scheduled report "${payload.reportName}".`,
  ]);

  return { subject, html, text };
}
