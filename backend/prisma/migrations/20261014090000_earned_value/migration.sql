-- Earned value (BR-301 to BR-303).

-- How each work package type earns value, versioned like the health rules.
CREATE TABLE "evm_setting_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evm_setting_sets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "evm_setting_sets_version_key" ON "evm_setting_sets"("version");

-- Each project's baselines: the plan earned value is measured against.
CREATE TABLE "evm_baselines" (
    "id" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bac" DOUBLE PRECISION NOT NULL,
    "items" INTEGER NOT NULL,
    "unpriced" INTEGER NOT NULL,
    "undated" INTEGER NOT NULL,

    CONSTRAINT "evm_baselines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "evm_baselines_projectId_number_key" ON "evm_baselines"("projectId", "number");
CREATE INDEX "evm_baselines_projectId_createdAt_idx" ON "evm_baselines"("projectId", "createdAt");

CREATE TABLE "evm_baseline_items" (
    "baselineId" TEXT NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "typeId" INTEGER NOT NULL,
    "isMilestone" BOOLEAN NOT NULL,
    "subject" TEXT NOT NULL,
    "estimatedHours" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION,
    "bac" DOUBLE PRECISION,
    "plannedStart" DATE,
    "plannedFinish" DATE,

    CONSTRAINT "evm_baseline_items_pkey" PRIMARY KEY ("baselineId", "workPackageId"),
    CONSTRAINT "evm_baseline_items_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "evm_baselines"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- A baseline is a record of what was agreed, so it is never edited: a new
-- plan is a new baseline. Deleting stays possible, for the project's deletion.
CREATE FUNCTION evm_baseline_unchanged() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A baseline is not changed once set; set a new one instead.';
END
$$;
CREATE TRIGGER evm_baselines_unchanged BEFORE UPDATE ON "evm_baselines"
    FOR EACH ROW EXECUTE FUNCTION evm_baseline_unchanged();
CREATE TRIGGER evm_baseline_items_unchanged BEFORE UPDATE ON "evm_baseline_items"
    FOR EACH ROW EXECUTE FUNCTION evm_baseline_unchanged();

-- The instance's working calendar on the date dimension, kept by the refresh:
-- its working week, less its non-working days. Earned value spreads a plan
-- over these days, as OpenProject schedules in them.
ALTER TABLE analytics.dim_date ADD COLUMN is_working_day BOOLEAN;
UPDATE analytics.dim_date SET is_working_day = NOT is_weekend;
ALTER TABLE analytics.dim_date ALTER COLUMN is_working_day SET NOT NULL;
COMMENT ON COLUMN analytics.dim_date.is_working_day IS 'A working day on the instance''s calendar — its working week less its non-working days — as at the last refresh.';

-- Earned value over time (BR-303), for BI: each project's, each portfolio's
-- and the instance's figures at the end of every week and month of their
-- plans, computed by the same definitions as EPM's dashboard and rewritten
-- daily. Periods after the day they were computed carry the plan alone.
CREATE TABLE analytics.fact_evm_period (
    scope_type      TEXT NOT NULL,              -- project | portfolio | instance
    scope_id        TEXT NOT NULL,
    bucket          TEXT NOT NULL,              -- week | month
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    period_end_key  INTEGER NOT NULL,
    -- What planned value was measured against: "baseline 2", or "current plan".
    measured_against TEXT,
    bac             DOUBLE PRECISION,
    pv              DOUBLE PRECISION,
    ev              DOUBLE PRECISION,
    ac              DOUBLE PRECISION,
    sv              DOUBLE PRECISION,
    cv              DOUBLE PRECISION,
    spi             DOUBLE PRECISION,
    cpi             DOUBLE PRECISION,
    eac             DOUBLE PRECISION,
    etc             DOUBLE PRECISION,
    vac             DOUBLE PRECISION,
    tcpi            DOUBLE PRECISION,
    is_forecast     BOOLEAN NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scope_type, scope_id, bucket, period_end)
);
COMMENT ON TABLE analytics.fact_evm_period IS 'Earned value at the end of each week and month (BR-303): planned value, earned value and actual cost with their variances, indices and forecasts, by project, portfolio and instance. Same definitions as EPM''s Earned value dashboard.';
