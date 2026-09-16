/**
 * What a mail provider looks like from the outbox's side.
 *
 * One method, taking a batch: the worker sends up to a hundred rows per tick,
 * and a provider that accepted one message at a time would turn that into a
 * hundred round trips. Results come back positionally, one per message, so the
 * worker can mark each row on its own outcome rather than the batch's.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export type SendResult =
  | { ok: true; providerId: string }
  /**
   * `retryable` is the provider's verdict on whether trying again could help:
   * a rate limit or an outage, yes; a rejected address or a bad request, no.
   */
  | { ok: false; error: string; retryable: boolean };

export interface EmailProvider {
  /** Always resolves with one result per message, in order. Never throws. */
  send(messages: OutgoingEmail[]): Promise<SendResult[]>;
}
