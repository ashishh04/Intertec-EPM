import { createHash, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

/**
 * Invitation tokens.
 *
 * The token itself exists in exactly one place: the link in the email. The
 * database holds a SHA-256 of it, so a read of the table — a backup, a
 * debugging session, a log of the row — yields nothing that opens an account.
 * Looking one up means hashing what the visitor presented and matching that.
 *
 * One live token per account. Creating a new one retires any earlier unused
 * ones, so a resent invitation makes the previous link stop working rather
 * than leaving two doors open.
 */

export const INVITE_TTL_DAYS = 7;

/** The page the frontend serves for an invitation. */
export const inviteUrl = (token: string): string => `${env.APP_BASE_URL}/invite/${token}`;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createInvite(input: {
  openProjectId: string;
  email: string;
  createdBy: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.inviteToken.updateMany({
      where: { openProjectId: input.openProjectId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.inviteToken.create({
      data: {
        openProjectId: input.openProjectId,
        tokenHash: hashInviteToken(token),
        email: input.email,
        createdBy: input.createdBy,
        expiresAt,
      },
    }),
  ]);

  return { token, expiresAt };
}
