-- Make scopeId non-nullable, with the empty string standing for "no id".
--
-- This is a correctness fix, not tidying. Postgres treats NULLs as DISTINCT in
-- a unique index, so `@@unique([scopeType, scopeId, sampledOn, metric])` would
-- not have constrained instance-wide rows at all -- every snapshot run would
-- have inserted a second copy of the same metric for the same day instead of
-- overwriting it, and the history would have silently double-counted.
--
-- No existing row is affected: every row currently carries a user id.

UPDATE "metric_snapshots" SET "scopeId" = '' WHERE "scopeId" IS NULL;

ALTER TABLE "metric_snapshots" ALTER COLUMN "scopeId" SET NOT NULL;
ALTER TABLE "metric_snapshots" ALTER COLUMN "scopeId" SET DEFAULT '';
