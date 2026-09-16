import { button, escape, layout, muted, paragraph, paragraphHtml, textBody, type RenderedEmail } from './layout.js';

/** Sent the moment a work package is assigned to someone. */
export interface TaskAssignedPayload {
  firstName: string;
  taskKey: string;
  subject: string;
  projectName: string;
  status: string;
  url: string;
}

export function render(payload: TaskAssignedPayload): RenderedEmail {
  const subject = `[${payload.taskKey}] Assigned to you: ${payload.subject}`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph('A work package has been assigned to you.') +
      paragraphHtml(
        `<strong>${escape(payload.taskKey)}</strong> &middot; ${escape(payload.subject)}`,
      ) +
      muted(`${payload.projectName} · ${payload.status}`) +
      button('Open the task', payload.url),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    'A work package has been assigned to you.',
    '',
    `${payload.taskKey} · ${payload.subject}`,
    `${payload.projectName} · ${payload.status}`,
    '',
    payload.url,
  ]);

  return { subject, html, text };
}
