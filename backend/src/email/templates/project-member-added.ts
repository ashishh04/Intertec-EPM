import {
  button,
  escape,
  layout,
  muted,
  paragraph,
  paragraphHtml,
  textBody,
  type RenderedEmail,
} from './layout.js';

/**
 * Sent when someone is given access to a project.
 *
 * EPM sends this rather than leaving it upstream. The system behind EPM has a
 * membership mailer of its own, but its delivery is configured for the host it
 * runs on, not for EPM's provider — in this deployment it cannot send at all,
 * so relying on it would mean nobody is ever told.
 */
export interface ProjectMemberAddedPayload {
  firstName: string;
  projectName: string;
  /** The roles granted, already joined for display. */
  roles: string;
  /** Who did it, for context. Empty when EPM cannot name them. */
  addedBy: string;
  url: string;
}

export function render(payload: ProjectMemberAddedPayload): RenderedEmail {
  const subject = `You have been added to ${payload.projectName}`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraphHtml(
        `You now have access to <strong>${escape(payload.projectName)}</strong>` +
          (payload.addedBy ? `, added by ${escape(payload.addedBy)}` : '') +
          '.',
      ) +
      muted(`Your role: ${payload.roles}`) +
      button('Open the project', payload.url),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    `You now have access to ${payload.projectName}` +
      (payload.addedBy ? `, added by ${payload.addedBy}` : '') +
      '.',
    `Your role: ${payload.roles}`,
    '',
    payload.url,
  ]);

  return { subject, html, text };
}
