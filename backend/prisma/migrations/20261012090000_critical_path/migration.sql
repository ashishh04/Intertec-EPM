-- Critical path and float (BR-101 to BR-104).
CREATE TABLE "schedule_floats" (
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "earlyStart" DATE NOT NULL,
    "earlyFinish" DATE NOT NULL,
    "lateStart" DATE NOT NULL,
    "lateFinish" DATE NOT NULL,
    "totalFloat" INTEGER NOT NULL,
    "freeFloat" INTEGER NOT NULL,
    "critical" BOOLEAN NOT NULL,
    "summary" BOOLEAN NOT NULL DEFAULT false,
    "inCycle" BOOLEAN NOT NULL DEFAULT false,
    "runId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_floats_pkey" PRIMARY KEY ("workPackageId")
);

CREATE INDEX "schedule_floats_projectId_totalFloat_idx" ON "schedule_floats"("projectId", "totalFloat");

CREATE TABLE "schedule_links" (
    "relationId" INTEGER NOT NULL,
    "predecessorId" INTEGER NOT NULL,
    "successorId" INTEGER NOT NULL,
    "predecessorProjectId" INTEGER,
    "successorProjectId" INTEGER,
    "lag" INTEGER NOT NULL DEFAULT 0,
    "driving" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "schedule_links_pkey" PRIMARY KEY ("relationId")
);

CREATE INDEX "schedule_links_predecessorProjectId_idx" ON "schedule_links"("predecessorProjectId");
CREATE INDEX "schedule_links_successorProjectId_idx" ON "schedule_links"("successorProjectId");

CREATE TABLE "schedule_runs" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "networkFingerprint" TEXT,
    "valuesFingerprint" TEXT,
    "workPackages" INTEGER NOT NULL DEFAULT 0,
    "relations" INTEGER NOT NULL DEFAULT 0,
    "scheduled" INTEGER NOT NULL DEFAULT 0,
    "unscheduled" INTEGER NOT NULL DEFAULT 0,
    "cycles" JSONB NOT NULL DEFAULT '[]',
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

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "schedule_runs_status_check" CHECK ("status" IN ('running', 'completed', 'failed'))
);

CREATE INDEX "schedule_runs_startedAt_idx" ON "schedule_runs"("startedAt");
CREATE INDEX "schedule_runs_status_startedAt_idx" ON "schedule_runs"("status", "startedAt");
