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

/**
 * Stands in for the project's name while the sentence around it is translated
 * and escaped, so the name can then be set in bold wherever the language puts
 * it. A private-use character: no translation or name contains it.
 */
const PROJECT = '\u{E000}';

export function render(payload: ProjectMemberAddedPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('You have been added to {project}', { project: payload.projectName });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const access = (project: string) =>
    payload.addedBy
      ? tr('You now have access to {project}, added by {name}.', { project, name: payload.addedBy })
      : tr('You now have access to {project}.', { project });
  const role = tr('Your role: {roles}', { roles: payload.roles });

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraphHtml(escape(access(PROJECT)).replace(PROJECT, () => `<strong>${escape(payload.projectName)}</strong>`)) +
      muted(role) +
      button(tr('Open the project'), payload.url),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      access(payload.projectName),
      role,
      '',
      payload.url,
    ],
    locale,
  );

  return { subject, html, text };
}
