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

/** Sent the moment a work package is assigned to someone. */
export interface TaskAssignedPayload {
  firstName: string;
  taskKey: string;
  subject: string;
  projectName: string;
  status: string;
  url: string;
}

export function render(payload: TaskAssignedPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('[{key}] Assigned to you: {subject}', { key: payload.taskKey, subject: payload.subject });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(tr('A work package has been assigned to you.')) +
      paragraphHtml(
        `<strong>${escape(payload.taskKey)}</strong> &middot; ${escape(payload.subject)}`,
      ) +
      muted(`${payload.projectName} · ${payload.status}`) +
      button(tr('Open the task'), payload.url),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      tr('A work package has been assigned to you.'),
      '',
      `${payload.taskKey} · ${payload.subject}`,
      `${payload.projectName} · ${payload.status}`,
      '',
      payload.url,
    ],
    locale,
  );

  return { subject, html, text };
}
