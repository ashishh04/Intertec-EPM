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

function seal(plaintext: string, withKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, withKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(
    '.',
  );
}

function unseal(value: string | null | undefined, withKey: Buffer): string | undefined {
  if (!value) return undefined;

  const [ivPart, tagPart, dataPart] = value.split('.');
  if (!ivPart || !tagPart || !dataPart) return undefined;

  try {
    const decipher = createDecipheriv(ALGORITHM, withKey, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

export function encryptToken(plaintext: string): string {
  return seal(plaintext, key);
}

/** Returns undefined rather than throwing: a token that will not decrypt is
 *  indistinguishable from no token, and both mean "sign in again". */
export function decryptToken(value: string | null | undefined): string | undefined {
  return unseal(value, key);
}

/**
 * A key of their own for the secrets behind two-factor authentication.
 *
 * Rotating SESSION_SECRET is routine: everyone signs in again and nothing is
 * lost (deploy/runbooks/secret-rotation.md). Sharing its key would turn that
 * routine into everyone's authenticator breaking at once, so EPM_MFA_KEY stands
 * apart once set. Falling back keeps an instance that has not set it working;
 * the prefix keeps the two keys different even then.
 */
const mfaKey = createHash('sha256').update(`epm-mfa:${env.EPM_MFA_KEY ?? env.SESSION_SECRET}`).digest();

export function encryptMfaSecret(secret: string): string {
  return seal(secret, mfaKey);
}

/** Undefined when it will not decrypt, which is what a lost or changed key looks like. */
export function decryptMfaSecret(value: string | null | undefined): string | undefined {
  return unseal(value, mfaKey);
}
