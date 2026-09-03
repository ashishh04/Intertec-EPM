-- EPM-owned notifications.
--
-- Additive. OpenProject notifications are still read through from upstream and
-- merged with these on the way out; this is storage for events OpenProject has
-- no concept of -- a health transition, a capacity change, a failed snapshot --
-- not a second copy of anything it already holds.
--
-- The unique key on (recipientId, dedupeKey) is the deduplication. Making it a
-- database constraint rather than a read-then-write check means two concurrent
-- producers cannot both decide a notification is new.
--
-- project_profiles gains one nullable column, without which a health transition
-- cannot be detected: health is computed per request and nothing remembers the
-- previous value.

-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN "lastNotifiedHealth" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipientId_dedupeKey_key"
    ON "notifications"("recipientId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_recipientId_createdAt_idx"
    ON "notifications"("recipientId", "createdAt");
