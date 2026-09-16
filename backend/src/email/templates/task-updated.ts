import { button, escape, layout, muted, paragraph, paragraphHtml, textBody, type RenderedEmail } from './layout.js';

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

export function render(payload: TaskUpdatedPayload): RenderedEmail {
  const subject = `[${payload.taskKey}] Updated: ${payload.subject}`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph('A work package assigned to you was updated.') +
      paragraphHtml(
        `<strong>${escape(payload.taskKey)}</strong> &middot; ${escape(payload.subject)}`,
      ) +
      muted(`${payload.projectName} · now ${payload.status}`) +
      button('Open the task', payload.url),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    'A work package assigned to you was updated.',
    '',
    `${payload.taskKey} · ${payload.subject}`,
    `${payload.projectName} · now ${payload.status}`,
    '',
    payload.url,
  ]);

  return { subject, html, text };
}
