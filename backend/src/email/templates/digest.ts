import { button, layout, list, listItem, muted, paragraph, textBody, type RenderedEmail } from './layout.js';
import { env } from '../../config/env.js';

/** One email a day for everything that did not warrant its own. */
export interface DigestPayload {
  firstName: string;
  /** e.g. "Friday 13 September". */
  dateLabel: string;
  items: { title: string; body: string; url?: string }[];
}

export function render(payload: DigestPayload): RenderedEmail {
  const count = payload.items.length;
  const subject = `Your EPM digest for ${payload.dateLabel} (${count} ${count === 1 ? 'update' : 'updates'})`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(`Here is what happened on your work since the last digest.`) +
      list(payload.items.map((item) => listItem(item.title, item.body, item.url)).join('')) +
      button('Open EPM', `${env.APP_BASE_URL}/notifications`) +
      muted('You receive this because daily digests are on in your EPM settings.'),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    'Here is what happened on your work since the last digest.',
    '',
    ...payload.items.flatMap((item) => [
      `- ${item.title}`,
      item.body ? `  ${item.body}` : undefined,
      item.url ? `  ${item.url}` : undefined,
    ]),
    '',
    `${env.APP_BASE_URL}/notifications`,
  ]);

  return { subject, html, text };
}
