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
 * A change to a work package someone is assigned to. Queued on the digest
 * channel, so this renders on its own only when sent individually.
 */
export interface TaskUpdatedPayload {
  firstName: string;
  taskKey: string;
  subject: string;
  projectName: string;
  status: string;
  url: string;
}

export function render(payload: TaskUpdatedPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('[{key}] Updated: {subject}', { key: payload.taskKey, subject: payload.subject });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const where = tr('{project} · now {status}', { project: payload.projectName, status: payload.status });

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(tr('A work package assigned to you was updated.')) +
      paragraphHtml(
        `<strong>${escape(payload.taskKey)}</strong> &middot; ${escape(payload.subject)}`,
      ) +
      muted(where) +
      button(tr('Open the task'), payload.url),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      tr('A work package assigned to you was updated.'),
      '',
      `${payload.taskKey} · ${payload.subject}`,
      where,
      '',
      payload.url,
    ],
    locale,
  );

  return { subject, html, text };
}
