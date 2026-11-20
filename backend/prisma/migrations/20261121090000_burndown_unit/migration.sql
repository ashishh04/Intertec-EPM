-- What a burndown sample counts: a sprint whose work has no story points is
-- counted in estimated hours, or in tasks, and its samples say which (November 2026).
ALTER TABLE "burndown_samples" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'points';
