import { button, layout, link, muted, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';

/**
 * The invitation to set a password.
 *
 * The link carries the only copy of the token, which is why the body says
 * nothing about the account beyond the person's first name: the email may sit
 * in a shared inbox or be forwarded, and the link alone is already enough.
 */
export interface InvitePayload {
  firstName: string;
  inviteUrl: string;
  /** ISO. */
  expiresAt: string;
  invitedBy: string;
}

export function render(payload: InvitePayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('You have been invited to EPM');
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  // The expiry in the reader's language and calendar; one that cannot be read
  // is "soon" rather than nothing.
  const expiry = Number.isNaN(new Date(payload.expiresAt).getTime())
    ? tr('This link works until soon. If it has expired, ask {name} to send a new one.', { name: payload.invitedBy })
    : tr('This link works until {date}. If it has expired, ask {name} to send a new one.', {
        date: locale.date(payload.expiresAt),
        name: payload.invitedBy,
      });

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(
        tr('{name} has set up an EPM account for you. Choose a password to start using it.', { name: payload.invitedBy }),
      ) +
      button(tr('Set your password'), payload.inviteUrl) +
      muted(expiry) +
      muted(tr('If the button does not open, paste this address into your browser:')) +
      `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;">${link(payload.inviteUrl)}</p>`,
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      tr('{name} has set up an EPM account for you. Choose a password to start using it:', { name: payload.invitedBy }),
      '',
      payload.inviteUrl,
      '',
      expiry,
    ],
    locale,
  );

  return { subject, html, text };
}
