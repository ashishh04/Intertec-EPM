import { env } from '../config/env.js';
import { createConsoleProvider } from './console.js';
import type { EmailProvider } from './provider.js';
import { createResendProvider } from './resend.js';
import { createSmtpProvider } from './smtp.js';

/**
 * The provider this process sends through.
 *
 * Chosen once from configuration, most specific first: a full SMTP mailbox if
 * one is configured, else a Resend key, else a logger that pretends to send.
 *
 * SMTP wins over Resend deliberately. Configuring a mailbox is the more
 * explicit act — it cannot happen by leaving a shared key in an environment —
 * and it is the option chosen precisely when Resend will not do, because Resend
 * refuses every recipient but its own account owner until a sending domain has
 * been verified in DNS.
 *
 * The choice is reported at startup by whoever starts the worker, so a
 * deployment that is silently logging instead of delivering — or sending from
 * the wrong mailbox — is visible in the first lines of its output.
 */

/** Complete enough to connect. A half-filled SMTP block is a misconfiguration. */
function smtpSettings() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_PORT, SMTP_SECURE } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return undefined;

  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    password: SMTP_PASSWORD,
    // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Explicit wins.
    secure: SMTP_SECURE ?? SMTP_PORT === 465,
  };
}

let provider: EmailProvider | undefined;

export function emailProvider(): EmailProvider {
  if (!provider) {
    const smtp = smtpSettings();
    provider = smtp
      ? createSmtpProvider(smtp)
      : env.RESEND_API_KEY
        ? createResendProvider(env.RESEND_API_KEY)
        : createConsoleProvider();
  }
  return provider;
}

/** For the startup log line. Never a key or a password. */
export function describeEmailProvider(): string {
  const smtp = smtpSettings();
  if (smtp) return `SMTP ${smtp.host}:${smtp.port} as ${smtp.user}, from ${env.EMAIL_FROM}`;
  if (env.RESEND_API_KEY) return `Resend, from ${env.EMAIL_FROM}`;
  return 'console (no SMTP or Resend configuration; email is logged, not sent)';
}

export { useEmailLogger } from './log.js';
export { enqueueEmail } from './outbox.js';
export { getPreferences, setPreferences } from './preferences.js';
export { resolveEmail, resolveRecipient } from './recipients.js';
