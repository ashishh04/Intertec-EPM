import { layout, muted, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';

/**
 * Telling someone their account's protection changed, or is under attack. Sent
 * whatever their email settings say, because this is how they find out. No
 * links, on purpose: an email about security should not teach people to click
 * through one, and everything it asks them to do starts at the sign-in page.
 */
export type SecurityNoticeKind = 'mfa-enabled' | 'mfa-disabled' | 'mfa-reset' | 'mfa-locked' | 'mfa-recovery-used';

export interface SecurityNoticePayload {
  /** Empty where it is not known: the greeting copes. */
  firstName: string;
  kind: SecurityNoticeKind;
}

export function render(payload: SecurityNoticePayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');

  const content: Record<SecurityNoticeKind, { subject: string; body: string; notYou: string }> = {
    'mfa-enabled': {
      subject: tr('Two-factor authentication is on for your EPM account'),
      body: tr('Two-factor authentication was just turned on for your EPM account. From now on, signing in also asks for a code from your authenticator app, and your other sessions have been signed out.'),
      notYou: tr('If this was not you, contact your administrator straight away.'),
    },
    'mfa-disabled': {
      subject: tr('Two-factor authentication is off for your EPM account'),
      body: tr('Two-factor authentication was just turned off for your EPM account. Signing in now asks only for your password.'),
      notYou: tr('If this was not you, change your password and contact your administrator straight away.'),
    },
    'mfa-reset': {
      subject: tr('An administrator reset two-factor authentication on your EPM account'),
      body: tr('An administrator reset two-factor authentication for your EPM account, and you have been signed out everywhere. Your old authenticator and recovery codes no longer work. Set it up again in Security settings once you have signed in.'),
      notYou: tr('If you did not ask for this, contact your administrator straight away.'),
    },
    'mfa-locked': {
      subject: tr('Repeated wrong sign-in codes on your EPM account'),
      body: tr('Someone entered too many wrong two-factor codes on your EPM account, so codes are refused for a while. To get that far they needed your password.'),
      notYou: tr('If this was not you, change your password as soon as you can. A recovery code still lets you sign in.'),
    },
    'mfa-recovery-used': {
      subject: tr('A recovery code was used on your EPM account'),
      body: tr('One of your two-factor recovery codes was just used on your EPM account. Each code works once.'),
      notYou: tr('If this was not you, change your password and contact your administrator straight away.'),
    },
  };

  const { subject, body, notYou } = content[payload.kind];

  return {
    subject,
    html: layout(subject, paragraph(greeting) + paragraph(body) + muted(notYou), locale),
    text: textBody([greeting, '', body, '', notYou], locale),
  };
}
