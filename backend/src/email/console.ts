import { randomUUID } from 'node:crypto';

import { emailLog } from './log.js';
import type { EmailProvider, OutgoingEmail, SendResult } from './provider.js';

/**
 * The provider in force when no Resend key is configured.
 *
 * It logs and succeeds, so development and tests exercise the whole path —
 * preferences, dedupe, rendering, the worker's claim-and-mark cycle — without
 * a message ever leaving the machine. Only subject and recipient are logged:
 * the body of an invite carries the token.
 */
export function createConsoleProvider(): EmailProvider {
  return {
    async send(messages: OutgoingEmail[]): Promise<SendResult[]> {
      return messages.map((message) => {
        const providerId = `console-${randomUUID()}`;
        emailLog.info({ to: message.to, subject: message.subject, providerId }, 'Email (not sent: no provider configured)');
        return { ok: true, providerId };
      });
    },
  };
}
