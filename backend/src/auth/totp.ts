import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The TOTP service: time-based one-time codes (RFC 6238), the kind every
 * authenticator app produces — Microsoft Authenticator, Google Authenticator,
 * Authy, 1Password and the rest.
 *
 * Deliberately small, and knows nothing of people, storage or sessions: it
 * turns a shared secret and the time into a code, and says which time step a
 * code belongs to. What that means for someone signing in is `domain/mfa.ts`.
 * The one primitive underneath is Node's HMAC, and `__checks__/totp.check.ts`
 * holds this file to the published test vectors of both RFCs.
 *
 * HMAC-SHA-1, six digits, thirty seconds: less a choice than the only
 * combination every app honours — several ignore the parameters in the QR code
 * and use these regardless. SHA-1's collision weakness does not reach HMAC.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** 160 bits, the length RFC 4226 recommends for HMAC-SHA-1. */
const SECRET_BYTES = 20;

/**
 * One step either side of now: a phone's clock a little out, or a code typed
 * as it rolled over, still works, without widening what a guess can hit by
 * more than the two extra codes RFC 6238 §5.2 allows for.
 */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, which is how authenticator apps take a secret. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    // Only the bits not yet written matter; without this the shift overflows.
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Accepts what people copy: any case, with spaces and padding. Throws on anything else. */
export function base32Decode(text: string): Buffer {
  const cleaned = text.toUpperCase().replace(/[\s=]/g, '');
  const output: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Not a base32 string.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(output);
}

/** A new shared secret, base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Which thirty-second step an instant falls in. */
export function totpStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226): the code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, '0');
}

/** The code a base32 secret gives at one time step. */
export function totpCode(secret: string, step: number = totpStep(), digits: number = TOTP_DIGITS): string {
  return hotp(base32Decode(secret), step, digits);
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The time step a code belongs to, or null if it is not a code for around now.
 *
 * Every candidate is compared, without stopping at a match, so the time taken
 * says nothing about which one matched; the newest wins, so that a code that
 * happens to repeat in the window is not mistaken for one already used. Saying
 * whether that step has already been spent is the caller's job, because only
 * the caller knows what was spent.
 */
export function matchTotpStep(secret: string, code: string, now: number = Date.now()): number | null {
  if (!/^\d+$/.test(code) || code.length !== TOTP_DIGITS) return null;

  const key = base32Decode(secret);
  const current = totpStep(now);
  let matched: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (sameCode(hotp(key, step), code)) matched = step;
  }
  return matched;
}

/**
 * The address a QR code carries, in the form every authenticator app reads:
 * https://github.com/google/google-authenticator/wiki/Key-Uri-Format.
 * The issuer appears twice on purpose, because older apps read only the label.
 */
export function otpauthUri(input: { secret: string; issuer: string; account: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.account)}`;
  return (
    `otpauth://totp/${label}?secret=${input.secret}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}
