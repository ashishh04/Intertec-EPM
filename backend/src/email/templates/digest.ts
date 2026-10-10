import { button, layout, list, listItem, muted, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';
import { env } from '../../config/env.js';

/** One email a day for everything that did not warrant its own. */
export interface DigestPayload {
  firstName: string;
  /** e.g. "Friday 13 September". English; kept for rows queued before `day`. */
  dateLabel: string;
  /** The digest's day, ISO. Written out in the reader's language and calendar. */
  day?: string;
  /** Each already written in the reader's language when it was queued. */
  items: { title: string; body: string; url?: string }[];
}

export function render(payload: DigestPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const count = payload.items.length;
  const date = payload.day ? locale.date(payload.day, 'weekday') : payload.dateLabel;
  const subject = tr('Your EPM digest for {date} ({count, plural, one {# update} other {# updates}})', { date, count });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(tr('Here is what happened on your work since the last digest.')) +
      list(payload.items.map((item) => listItem(item.title, item.body, item.url)).join('')) +
      button(tr('Open EPM'), `${env.APP_BASE_URL}/notifications`) +
      muted(tr('You receive this because daily digests are on in your EPM settings.')),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      tr('Here is what happened on your work since the last digest.'),
      '',
      ...payload.items.flatMap((item) => [
        `- ${item.title}`,
        item.body ? `  ${item.body}` : undefined,
        item.url ? `  ${item.url}` : undefined,
      ]),
      '',
      `${env.APP_BASE_URL}/notifications`,
    ],
    locale,
  );

  return { subject, html, text };
}
