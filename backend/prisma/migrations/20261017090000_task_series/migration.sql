-- Recurring tasks (BR-105 to BR-107).

-- A series: the template work package, the rule its occurrences follow, how
-- early each occurrence's work package is made and how long each runs. One
-- series per template.
CREATE TABLE "task_series" (
    "id" TEXT NOT NULL,
    "templateWorkPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "rule" JSONB NOT NULL,
    "leadDays" INTEGER NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generateFrom" DATE NOT NULL,
    "nextOccurrence" DATE,
    "lastGeneratedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorMessage" JSONB,
    "lastErrorAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "task_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_series_state_check" CHECK ("state" IN ('active', 'paused', 'cancelled')),
    CONSTRAINT "task_series_leadDays_check" CHECK ("leadDays" BETWEEN 0 AND 365),
    CONSTRAINT "task_series_durationDays_check" CHECK ("durationDays" BETWEEN 0 AND 365)
);

CREATE UNIQUE INDEX "task_series_templateWorkPackageId_key" ON "task_series"("templateWorkPackageId");
CREATE INDEX "task_series_projectId_idx" ON "task_series"("projectId");
CREATE INDEX "task_series_state_nextOccurrence_idx" ON "task_series"("state", "nextOccurrence");

-- Cancelling is final: generation stops for good, and nothing turns a
-- cancelled series back on. Deleting stays possible, for clearing up.
CREATE FUNCTION task_series_cancel_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."state" = 'cancelled' AND NEW."state" <> 'cancelled' THEN
        RAISE EXCEPTION 'A cancelled series stays cancelled.';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER task_series_cancel_is_final BEFORE UPDATE ON "task_series"
    FOR EACH ROW EXECUTE FUNCTION task_series_cancel_is_final();

-- One row per occurrence, and the row is the claim: inserted before the work
-- package is made — only while the series is active at the version being
-- worked — so two servers, or the timer and someone pressing "generate now",
-- cannot both make the same occurrence. Filled in once the work package exists;
-- a claim still empty after a few minutes is a crashed attempt and is retried.
CREATE TABLE "task_series_instances" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "occurrence" DATE NOT NULL,
    "workPackageId" INTEGER,
    "seriesVersion" INTEGER NOT NULL,
    "claimedBy" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedAt" TIMESTAMP(3),

    CONSTRAINT "task_series_instances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_series_instances_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "task_series"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_series_instances_seriesId_occurrence_key" ON "task_series_instances"("seriesId", "occurrence");
CREATE UNIQUE INDEX "task_series_instances_workPackageId_key" ON "task_series_instances"("workPackageId");
