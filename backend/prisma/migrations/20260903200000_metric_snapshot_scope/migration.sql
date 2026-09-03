-- Generalise a metric snapshot's scope from "a user, or nothing" to a typed
-- reference, so portfolios, teams and departments can have history too.
--
-- The column is RENAMED, not dropped and recreated: this database already holds
-- real snapshots, and they are the historical record. Every existing row keeps
-- its value and gains the scopeType it always implied -- 'user' where an id was
-- present, 'instance' where it was null.
--
-- scopeId is not a foreign key. A snapshot states what was true on a date; a
-- department deleted afterwards must not take its own history with it.

-- AlterTable: preserve existing rows
ALTER TABLE "metric_snapshots" RENAME COLUMN "scopeUserId" TO "scopeId";
ALTER TABLE "metric_snapshots" ADD COLUMN "scopeType" TEXT NOT NULL DEFAULT 'instance';

-- Backfill the type the existing rows always meant.
UPDATE "metric_snapshots" SET "scopeType" = 'user' WHERE "scopeId" IS NOT NULL;

-- DropIndex: superseded by the scope-aware key below.
DROP INDEX IF EXISTS "metric_snapshots_scopeUserId_sampledOn_metric_key";

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_scopeType_scopeId_sampledOn_metric_key"
    ON "metric_snapshots"("scopeType", "scopeId", "sampledOn", "metric");

-- CreateIndex
CREATE INDEX "metric_snapshots_scopeType_scopeId_metric_sampledOn_idx"
    ON "metric_snapshots"("scopeType", "scopeId", "metric", "sampledOn");
