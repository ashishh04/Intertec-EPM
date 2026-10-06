import { env } from '../config/env.js';
import type { EmailProvider, OutgoingEmail, SendResult } from './provider.js';

/**
 * Resend, through its batch endpoint.
 *
 * Called with `fetch` rather than the SDK: one POST with a bearer header does
 * not justify a dependency, and keeping the HTTP visible makes the status
 * mapping below auditable.
 *
 * The API key travels in the Authorization header and nowhere else. Nothing
 * from the request — not the header, not the body — is logged here.
 */

const BATCH_URL = 'https://api.resend.com/emails/batch';
/** One message at a time: the batch endpoint takes no attachments. */
const SINGLE_URL = 'https://api.resend.com/emails';

/** Resend refuses larger batches; the worker never sends more than this. */
export const RESEND_BATCH_LIMIT = 100;

const TIMEOUT_MS = 20_000;

interface BatchResponse {
  data?: { id: string }[];
}

interface ErrorResponse {
  message?: string;
  name?: string;
}

/** A message with files, through the single-message endpoint. */
async function sendOne(apiKey: string, message: OutgoingEmail): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(SINGLE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
        attachments: (message.attachments ?? []).map((file) => ({
          filename: file.filename,
          content: file.content.toString('base64'),
          content_type: file.contentType,
        })),
      }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The provider could not be reached.', retryable: true };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, providerId: body.id ?? 'unknown' };
  }
  const body = (await response.json().catch(() => ({}))) as ErrorResponse;
  return {
    ok: false,
    error: `Resend responded with ${response.status}${body.message ? `: ${body.message}` : ''}`,
    retryable: response.status === 429 || response.status >= 500,
  };
}

export function createResendProvider(apiKey: string): EmailProvider {
  const provider: EmailProvider = {
    async send(messages: OutgoingEmail[]): Promise<SendResult[]> {
      if (messages.length === 0) return [];

      // Messages with files go one by one; the rest still go as one batch.
      if (messages.some((message) => message.attachments?.length)) {
        const plain = messages.filter((message) => !message.attachments?.length);
        const plainResults = plain.length > 0 ? await provider.send(plain) : [];
        let next = 0;
        const results: SendResult[] = [];
        for (const message of messages) {
          results.push(message.attachments?.length ? await sendOne(apiKey, message) : plainResults[next++]!);
        }
        return results;
      }

      let response: Response;
      try {
        response = await fetch(BATCH_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            messages.map((message) => ({
              from: env.EMAIL_FROM,
              to: [message.to],
              subject: message.subject,
              html: message.html,
              text: message.text,
              ...(message.headers ? { headers: message.headers } : {}),
            })),
          ),
        });
      } catch (error) {
        // Network failure or timeout: nothing was accepted, and trying again
        // later is the right response to both.
        const reason = error instanceof Error ? error.message : 'The provider could not be reached.';
        return messages.map(() => ({ ok: false, error: reason, retryable: true }));
      }

      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as BatchResponse;
        const ids = body.data ?? [];

        // The batch endpoint is all-or-nothing, so a 2xx means every message
        // was accepted. Ids come back in order; a missing one is still a send,
        // just an untraceable one.
        return messages.map((_, index) => ({
          ok: true,
          providerId: ids[index]?.id ?? 'unknown',
        }));
      }

      const body = (await response.json().catch(() => ({}))) as ErrorResponse;
      const error = `Resend responded with ${response.status}${body.message ? `: ${body.message}` : ''}`;

      // 429 and 5xx are the provider's problem and pass with time. Any other
      // 4xx is ours — a rejected address, an unverified domain, a bad key — and
      // retrying it would just fail the same way until someone intervenes.
      const retryable = response.status === 429 || response.status >= 500;

      return messages.map(() => ({ ok: false, error, retryable }));
    },
  };
  return provider;
}
