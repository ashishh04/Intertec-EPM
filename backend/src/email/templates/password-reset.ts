import { button, layout, link, muted, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';

/**
 * A forgotten-password email (Module 1): the link to choose a new password,
 * or, for an administrator, whose password is never reset by email, why
 * there is no link. Like an invitation, it says nothing about the account
 * beyond the person's first name: the link alone is enough to use it.
 */
export interface PasswordResetPayload {
  firstName: string;
  /** Absent for an account whose password is not reset by email. */
  resetUrl?: string;
  validMinutes?: number;
}

export function render(payload: PasswordResetPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const notYou = tr('If you did not ask for this, you can ignore this email: your password has not changed.');

  if (!payload.resetUrl) {
    const subject = tr('About resetting your EPM password');
    const body = tr(
      'Someone asked to reset the password of your EPM account. Administrator passwords are not reset by email: ask another administrator to set a new one for you.',
    );
    return {
      subject,
      html: layout(subject, paragraph(greeting) + paragraph(body) + muted(notYou), locale),
      text: textBody([greeting, '', body, '', notYou], locale),
    };
  }

  const subject = tr('Reset your EPM password');
  const intro = tr('Someone, hopefully you, asked to reset the password of your EPM account. Choose a new one here:');
  const expiry = tr('The link works once, for {minutes} minutes. After that, ask for a new one on the sign-in page.', {
    minutes: payload.validMinutes ?? 60,
  });

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(intro) +
      button(tr('Choose a new password'), payload.resetUrl) +
      muted(expiry) +
      muted(tr('If the button does not open, paste this address into your browser:')) +
      `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;">${link(payload.resetUrl)}</p>` +
      muted(notYou),
    locale,
  );

  const text = textBody([greeting, '', intro, '', payload.resetUrl, '', expiry, '', notYou], locale);

  return { subject, html, text };
}
