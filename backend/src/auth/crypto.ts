import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

/**
 * Encryption for OAuth tokens at rest.
 *
 * A stored access token is a bearer credential: anyone who reads the sessions
 * table can act as that user against OpenProject. Encrypting with a key derived
 * from SESSION_SECRET means a database dump alone is not enough — an attacker
 * needs the application's configuration too.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypted into
 * something else.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** SESSION_SECRET is a passphrase, not a 32-byte key; hash it to the right size. */
const key = createHash('sha256').update(env.SESSION_SECRET).digest();

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(
    '.',
  );
}

/** Returns undefined rather than throwing: a token that will not decrypt is
 *  indistinguishable from no token, and both mean "sign in again". */
export function decryptToken(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const [ivPart, tagPart, dataPart] = value.split('.');
  if (!ivPart || !tagPart || !dataPart) return undefined;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}
