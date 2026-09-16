import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '../config/env.js';
import type { EmailProvider, OutgoingEmail, SendResult } from './provider.js';

/**
 * Any SMTP server, including Gmail.
 *
 * The reason this exists alongside Resend: Resend refuses to deliver to
 * anybody but the account owner until a sending domain is verified in DNS, so
 * an instance without that DNS work can only email one person. A mailbox the
 * organisation already owns has no such gate — it will send to anyone from the
 * moment its credentials are correct.
 *
 * Unlike the Resend provider this speaks a stateful protocol, so it carries a
 * dependency rather than a `fetch`. Connections are pooled: the worker hands
 * over a batch of up to a hundred, and one TCP handshake and TLS negotiation
 * per message would dominate the send.
 *
 * SMTP has no batch call, so every message is sent on its own and marked on its
 * own result — which is what the outbox wants anyway. A batch endpoint that is
 * all-or-nothing, as Resend's is, is the awkward case, not this one.
 */

/** Matches the worker's claim size; the pool queues beyond `maxConnections`. */
const SMTP_BATCH_LIMIT = 100;

const TIMEOUT_MS = 20_000;

/**
 * Whether trying the same message again could succeed.
 *
 * SMTP says this itself: a 4xx reply is a transient refusal — greylisting, a
 * full mailbox, a rate limit — and 5xx is permanent. Failures that never reach
 * a reply code are transport problems, which time usually fixes. The exception
 * is authentication: a wrong App Password will be wrong on every retry, and
 * retrying it risks the provider locking the mailbox.
 */
function isRetryable(error: unknown): boolean {
  const err = error as { responseCode?: number; code?: string } | undefined;

  if (err?.code === 'EAUTH') return false;
  if (typeof err?.responseCode === 'number') return err.responseCode < 500;

  return true;
}

function describe(error: unknown): string {
  const err = error as { responseCode?: number; message?: string } | undefined;
  const code = err?.responseCode ? ` (SMTP ${err.responseCode})` : '';
  return `SMTP send failed${code}: ${err?.message ?? 'no detail from the server'}`;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  /**
   * Implicit TLS from the first byte, as on port 465. Port 587 starts in the
   * clear and upgrades with STARTTLS, which nodemailer does on its own.
   */
  secure: boolean;
}

export function createSmtpProvider(settings: SmtpSettings): EmailProvider {
  let transport: Transporter | undefined;

  // Built on first use rather than at import, so a process that never sends
  // mail never opens a socket.
  const connection = (): Transporter => {
    transport ??= nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      pool: true,
      maxConnections: 5,
      maxMessages: SMTP_BATCH_LIMIT,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
    return transport;
  };

  return {
    async send(messages: OutgoingEmail[]): Promise<SendResult[]> {
      if (messages.length === 0) return [];

      const results = await Promise.allSettled(
        messages.map((message) =>
          connection().sendMail({
            from: env.EMAIL_FROM,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.headers ? { headers: message.headers } : {}),
          }),
        ),
      );

      // Positional, one per message, as the interface requires.
      return results.map((result) => {
        if (result.status === 'fulfilled') {
          // The server's queue id, when it gave one. Useful for tracing a
          // message in the mailbox provider's own logs.
          return { ok: true, providerId: result.value.messageId ?? 'unknown' };
        }
        return {
          ok: false,
          error: describe(result.reason),
          retryable: isRetryable(result.reason),
        };
      });
    },
  };
}
