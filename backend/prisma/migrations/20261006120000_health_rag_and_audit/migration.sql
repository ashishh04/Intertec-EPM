-- Project health as the BRD defines it (BR-204, BR-205, BR-206), and the
-- activity journal that EPM-owned data never had (BRL-02, NFR07).

-- Planned dates. OpenProject projects carry none, so schedule variance had
-- nothing to be measured against.
ALTER TABLE "project_profiles" ADD COLUMN "plannedStart" DATE;
ALTER TABLE "project_profiles" ADD COLUMN "plannedFinish" DATE;

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL,
    "projectId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_seq_key" ON "audit_events"("seq");
CREATE INDEX "audit_events_projectId_seq_idx" ON "audit_events"("projectId", "seq");
CREATE INDEX "audit_events_entityType_entityId_seq_idx" ON "audit_events"("entityType", "entityId", "seq");
CREATE INDEX "audit_events_action_occurredAt_idx" ON "audit_events"("action", "occurredAt");

-- The journal is append-only below the application, not by convention: any
-- UPDATE, DELETE or TRUNCATE is refused by the database itself. A retention
-- policy, when one is agreed, will need its own deliberate path around this.
CREATE FUNCTION "audit_events_refuse_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update_or_delete"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_refuse_change"();

CREATE TRIGGER "audit_events_no_truncate"
    BEFORE TRUNCATE ON "audit_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_refuse_change"();

-- CreateTable
CREATE TABLE "health_rule_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "health_rule_sets_version_key" ON "health_rule_sets"("version");

-- CreateTable
CREATE TABLE "project_health_states" (
    "projectId" TEXT NOT NULL,
    "levels" JSONB NOT NULL,
    "criteria" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_health_states_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "project_health_overrides" (
    "projectId" TEXT NOT NULL,
    "levels" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_health_overrides_pkey" PRIMARY KEY ("projectId")
);

-- Carry existing pins across. They were set before a reason was required, so
-- they say so rather than inventing one, and they keep only the dimensions
-- that still exist: scope and resources were replaced by the BRD's criteria,
-- and a pin on a dimension that is no longer measured would pin nothing.
WITH carried AS (
    SELECT
        "openProjectId" AS "projectId",
        (
            SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
            FROM jsonb_each("healthOverride"::jsonb)
            WHERE key IN ('overall', 'schedule', 'budget')
              AND value #>> '{}' IN ('healthy', 'warning', 'critical')
        ) AS "levels"
    FROM "project_profiles"
    WHERE "healthOverride" IS NOT NULL
      AND jsonb_typeof("healthOverride"::jsonb) = 'object'
)
INSERT INTO "project_health_overrides" ("projectId", "levels", "reason", "setBy", "setAt")
SELECT "projectId", "levels",
       'Set before an override needed a reason; carried over unchanged.',
       'unknown', CURRENT_TIMESTAMP
FROM carried
WHERE "levels" <> '{}'::jsonb;

INSERT INTO "audit_events" ("id", "actorKind", "projectId", "entityType", "entityId",
                            "action", "summary", "reason", "after")
SELECT 'mig-' || "projectId", 'system', "projectId", 'project', "projectId",
       'health.override.carried',
       'A health override set before reasons were required was carried over.',
       "reason", "levels"
FROM "project_health_overrides";

-- The old pins now live above; the column stays, unread, so nothing is lost.
UPDATE "project_profiles" SET "healthOverride" = NULL WHERE "healthOverride" IS NOT NULL;
