import { button, layout, link, muted, paragraph, textBody, type RenderedEmail } from './layout.js';

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

function expiryLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'soon';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function render(payload: InvitePayload): RenderedEmail {
  const expires = expiryLabel(payload.expiresAt);
  const subject = 'You have been invited to EPM';

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(
        `${payload.invitedBy} has set up an EPM account for you. Choose a password to start using it.`,
      ) +
      button('Set your password', payload.inviteUrl) +
      muted(`This link works until ${expires}. If it has expired, ask ${payload.invitedBy} to send a new one.`) +
      muted('If the button does not open, paste this address into your browser:') +
      `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;">${link(payload.inviteUrl)}</p>`,
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    `${payload.invitedBy} has set up an EPM account for you. Choose a password to start using it:`,
    '',
    payload.inviteUrl,
    '',
    `This link works until ${expires}. If it has expired, ask ${payload.invitedBy} to send a new one.`,
  ]);

  return { subject, html, text };
}
