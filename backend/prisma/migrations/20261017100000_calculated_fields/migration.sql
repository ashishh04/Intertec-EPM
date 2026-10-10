-- Calculated fields (BR-406 to BR-408).

-- The definitions: a formula, the type it gives, where it applies, and the
-- OpenProject custom field its values are mirrored into.
CREATE TABLE "calculated_fields" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "resultType" TEXT NOT NULL,
    "expression" TEXT NOT NULL,
    "references" JSONB NOT NULL DEFAULT '{}',
    "format" JSONB NOT NULL DEFAULT '{}',
    "customFieldId" INTEGER,
    "projectIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "typeIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calculated_fields_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "calculated_fields_resultType_check" CHECK ("resultType" IN ('number', 'date', 'text', 'boolean'))
);

CREATE UNIQUE INDEX "calculated_fields_key_key" ON "calculated_fields"("key");
CREATE UNIQUE INDEX "calculated_fields_customFieldId_key" ON "calculated_fields"("customFieldId");
CREATE INDEX "calculated_fields_active_idx" ON "calculated_fields"("active");

-- Each field's last value on each work package it applies to, with the reason
-- when there is none: evaluated on write and kept, so a read never computes.
CREATE TABLE "calculated_values" (
    "fieldId" TEXT NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "numberValue" DOUBLE PRECISION,
    "dateValue" DATE,
    "textValue" TEXT,
    "booleanValue" BOOLEAN,
    "reason" TEXT,
    "reasonMessage" JSONB,
    "fieldVersion" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calculated_values_pkey" PRIMARY KEY ("fieldId", "workPackageId"),
    CONSTRAINT "calculated_values_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "calculated_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "calculated_values_workPackageId_idx" ON "calculated_values"("workPackageId");
CREATE INDEX "calculated_values_fieldId_projectId_idx" ON "calculated_values"("fieldId", "projectId");

-- One pass over every field, as schedule_runs records the critical path's.
CREATE TABLE "calculated_runs" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inputsFingerprint" TEXT,
    "valuesFingerprint" TEXT,
    "definitionsFingerprint" TEXT,
    "day" TEXT,
    "fields" INTEGER NOT NULL DEFAULT 0,
    "workPackages" INTEGER NOT NULL DEFAULT 0,
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "empty" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "mirrored" INTEGER NOT NULL DEFAULT 0,
    "mirrorSkipped" INTEGER NOT NULL DEFAULT 0,
    "mirrorError" TEXT,
    "readMs" INTEGER,
    "computeMs" INTEGER,
    "storeMs" INTEGER,
    "mirrorMs" INTEGER,
    "durationMs" INTEGER,
    "error" TEXT,

    CONSTRAINT "calculated_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "calculated_runs_status_check" CHECK ("status" IN ('running', 'completed', 'failed'))
);

CREATE INDEX "calculated_runs_startedAt_idx" ON "calculated_runs"("startedAt");
CREATE INDEX "calculated_runs_status_startedAt_idx" ON "calculated_runs"("status", "startedAt");

-- For BI (BR-407): every calculated value, beside the reporting model. A view
-- of EPM's own records rather than a loaded table, so it is never behind; the
-- values are kept out of OpenProject's journals, so the model's work package
-- versions do not carry them. Join on work_package_id.
CREATE VIEW analytics.fact_calculated_value AS
SELECT f."key"           AS field_key,
       f."name"          AS field_name,
       f."resultType"    AS result_type,
       f."expression"    AS expression,
       f."customFieldId" AS custom_field_id,
       v."workPackageId" AS work_package_id,
       v."projectId"     AS project_id,
       v."numberValue"   AS number_value,
       v."dateValue"     AS date_value,
       v."textValue"     AS text_value,
       v."booleanValue"  AS boolean_value,
       v."reason"        AS empty_reason,
       v."updatedAt"     AS computed_at
  FROM public."calculated_values" v
  JOIN public."calculated_fields" f ON f."id" = v."fieldId"
 WHERE f."active";
COMMENT ON VIEW analytics.fact_calculated_value IS 'Calculated fields (BR-406 to BR-408): each active field''s current value on each work package it applies to, one typed column per result type, and why a value is empty when it is. Join to fact_work_package on work_package_id. The same values EPM shows and mirrors into each field''s OpenProject custom field (cf_<custom_field_id>).';
