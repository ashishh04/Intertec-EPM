import { prisma } from '../db/prisma.js';
import { resetMfa } from '../domain/mfa.js';

/**
 * Break glass: resets one person's two-factor authentication from the server.
 *
 * For the one case the Administration page cannot reach: the last administrator
 * has lost their phone and their recovery codes, so nobody can sign in to reset
 * it for them. Anyone who can run this already holds the server, so it asks for
 * nothing more. It is journalled like every other reset, with no person as the
 * actor, and the owner is emailed.
 *
 *   npx tsx --env-file-if-exists=.env src/scripts/mfa-reset.ts <OpenProject user id>
 *   node dist/scripts/mfa-reset.js <OpenProject user id>      (in the backend container)
 */

const userId = process.argv[2];
if (!userId || !/^\d+$/.test(userId)) {
  console.error('Usage: mfa-reset <OpenProject user id>');
  process.exit(2);
}

const removed = await resetMfa({
  userId,
  name: `#${userId}`,
  actorId: null,
  actorKind: 'system',
});

console.log(
  removed
    ? `Two-factor authentication reset for user ${userId}; they are signed out everywhere.`
    : `User ${userId} had no authenticator set up. Nothing changed.`,
);
await prisma.$disconnect();
