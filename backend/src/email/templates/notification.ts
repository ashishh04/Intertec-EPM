import { button, layout, paragraph, textBody, type RenderedEmail } from './layout.js';

/** An EPM notification — a health change, a capacity change — as an email. */
export interface NotificationPayload {
  firstName: string;
  title: string;
  body: string;
  url?: string;
}

export function render(payload: NotificationPayload): RenderedEmail {
  const subject = payload.title;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(payload.title) +
      (payload.body ? paragraph(payload.body) : '') +
      (payload.url ? button('Open in EPM', payload.url) : ''),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    payload.title,
    payload.body || undefined,
    payload.url ? '' : undefined,
    payload.url,
  ]);

  return { subject, html, text };
}
