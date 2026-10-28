-- Marks an invitation link retired by a newer one, apart from one that was used.
ALTER TABLE "invite_tokens" ADD COLUMN "replacedAt" TIMESTAMP(3);
