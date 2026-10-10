import { button, layout, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';

/** An EPM notification — a health change, a capacity change — as an email. */
export interface NotificationPayload {
  firstName: string;
  /** Already written in the reader's language when the notification was made. */
  title: string;
  body: string;
  url?: string;
}

export function render(payload: NotificationPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = payload.title;
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(payload.title) +
      (payload.body ? paragraph(payload.body) : '') +
      (payload.url ? button(tr('Open in EPM'), payload.url) : ''),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      payload.title,
      payload.body || undefined,
      payload.url ? '' : undefined,
      payload.url,
    ],
    locale,
  );

  return { subject, html, text };
}
