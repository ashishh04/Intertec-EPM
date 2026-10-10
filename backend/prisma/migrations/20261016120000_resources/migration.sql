-- Resources and capacity (Module 6: BR-110 to BR-112, BR-312 to BR-316).
--
-- Roles for people and placeholders; work schedules with an employment
-- fraction, and time off, for the availability model; planned allocations;
-- versioned resource settings; levelling pins and runs; a billable flag on
-- projects. And, for the BI layer, capacity, demand and logged time by person
-- and week.

-- AlterTable
ALTER TABLE "placeholder_people" ADD COLUMN     "resourceRoleId" TEXT;

-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN     "billable" BOOLEAN;

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "resourceRoleId" TEXT;

-- CreateTable
CREATE TABLE "resource_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "hours" JSONB NOT NULL,
    "fraction" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'epm',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "hoursPerDay" DOUBLE PRECISION,
    "kind" TEXT NOT NULL DEFAULT 'leave',
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'epm',
    "externalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "personId" TEXT,
    "placeholderId" TEXT,
    "roleId" TEXT,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "hoursPerWeek" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_setting_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_setting_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_package_pins" (
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "reason" TEXT,
    "previousScheduleManually" BOOLEAN NOT NULL,
    "pinnedBy" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_package_pins_pkey" PRIMARY KEY ("workPackageId")
);

-- CreateTable
CREATE TABLE "levelling_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "scope" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "error" TEXT,

    CONSTRAINT "levelling_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "levelling_items" (
    "runId" TEXT NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "assigneeId" INTEGER,
    "hours" DOUBLE PRECISION NOT NULL,
    "beforeStart" DATE NOT NULL,
    "beforeDue" DATE NOT NULL,
    "afterStart" DATE NOT NULL,
    "afterDue" DATE NOT NULL,
    "beforeManual" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "position" INTEGER NOT NULL,

    CONSTRAINT "levelling_items_pkey" PRIMARY KEY ("runId","workPackageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_openProjectId_effectiveFrom_key" ON "work_schedules"("openProjectId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "time_off_openProjectId_startsOn_idx" ON "time_off"("openProjectId", "startsOn");

-- CreateIndex
CREATE UNIQUE INDEX "time_off_source_externalId_key" ON "time_off"("source", "externalId");

-- CreateIndex
CREATE INDEX "resource_allocations_projectId_idx" ON "resource_allocations"("projectId");

-- CreateIndex
CREATE INDEX "resource_allocations_personId_idx" ON "resource_allocations"("personId");

-- CreateIndex
CREATE INDEX "resource_allocations_placeholderId_idx" ON "resource_allocations"("placeholderId");

-- CreateIndex
CREATE INDEX "resource_allocations_roleId_idx" ON "resource_allocations"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "resource_setting_sets_version_key" ON "resource_setting_sets"("version");

-- CreateIndex
CREATE INDEX "work_package_pins_projectId_idx" ON "work_package_pins"("projectId");

-- CreateIndex
CREATE INDEX "levelling_runs_createdAt_idx" ON "levelling_runs"("createdAt");

-- CreateIndex
CREATE INDEX "placeholder_people_resourceRoleId_idx" ON "placeholder_people"("resourceRoleId");

-- CreateIndex
CREATE INDEX "user_profiles_resourceRoleId_idx" ON "user_profiles"("resourceRoleId");

-- AddForeignKey
ALTER TABLE "placeholder_people" ADD CONSTRAINT "placeholder_people_resourceRoleId_fkey" FOREIGN KEY ("resourceRoleId") REFERENCES "resource_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_resourceRoleId_fkey" FOREIGN KEY ("resourceRoleId") REFERENCES "resource_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_placeholderId_fkey" FOREIGN KEY ("placeholderId") REFERENCES "placeholder_people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "resource_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "levelling_items" ADD CONSTRAINT "levelling_items_runId_fkey" FOREIGN KEY ("runId") REFERENCES "levelling_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A role's name is unique regardless of case, as teams' and departments' are.
CREATE UNIQUE INDEX "resource_roles_name_lower_key" ON "resource_roles" (LOWER("name"));

-- BI: each person's week — the hours they were available, the work assigned
-- to them spread over it (demand), the planned allocations booked to them, and
-- the time they logged, billable and not. Past weeks are as logged; weeks from
-- the current one on are the forecast. Rewritten each day.
CREATE TABLE analytics.fact_capacity_week (
    person_id          integer          NOT NULL,
    week_start         date             NOT NULL,
    week_start_key     integer          NOT NULL,
    role_id            text,
    team_id            text,
    department_id      text,
    available_hours    double precision NOT NULL,
    demand_hours       double precision NOT NULL,
    planned_hours      double precision NOT NULL,
    logged_hours       double precision NOT NULL,
    billable_hours     double precision NOT NULL,
    non_billable_hours double precision NOT NULL,
    is_forecast        boolean          NOT NULL,
    computed_at        timestamptz      NOT NULL,
    PRIMARY KEY (person_id, week_start)
);
CREATE INDEX fact_capacity_week_week_idx ON analytics.fact_capacity_week (week_start);

-- BI: the roles the fact above names.
CREATE TABLE analytics.dim_resource_role (
    role_id     text    PRIMARY KEY,
    name        text    NOT NULL,
    is_archived boolean NOT NULL
);
