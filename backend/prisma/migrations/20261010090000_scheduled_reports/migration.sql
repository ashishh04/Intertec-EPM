-- Scheduled report distribution (BRQ-08: BR-207 to BR-210).
--
-- A report schedule binds a dashboard or a saved view to a frequency, a time
-- in a time zone, a window it may still go out in, its formats, and its
-- recipients: people with accounts, and addresses outside the organisation
-- once someone other than whoever set them has approved them. Each run is
-- logged with the definition as it then stood; each recipient's copy is
-- rendered with their own access, recorded with the projects it covered and
-- how many their access left out, and carried by an outbox row whose status
-- is the delivery's. Rendered files are kept for a shorter period than runs.

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'instance',
    "periodPreset" TEXT NOT NULL DEFAULT 'last-4-weeks',
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "dayOfMonth" INTEGER,
    "timeOfDay" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "windowMinutes" INTEGER NOT NULL DEFAULT 120,
    "formats" TEXT[],
    "recipientUserIds" TEXT[],
    "externalEmails" TEXT[],
    "externalApprovedBy" TEXT,
    "externalApprovedAt" TIMESTAMP(3),
    "externalSetBy" TEXT,
    "ownerId" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "periodFrom" TEXT,
    "periodTo" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "triggeredBy" TEXT,

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "recipientKind" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT,
    "renderStatus" TEXT NOT NULL,
    "reason" TEXT,
    "projectIds" TEXT[],
    "excludedProjects" INTEGER NOT NULL DEFAULT 0,
    "outboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_artifacts" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_schedules_active_nextRunAt_idx" ON "report_schedules"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "report_runs_scheduleId_startedAt_idx" ON "report_runs"("scheduleId", "startedAt");

-- CreateIndex
CREATE INDEX "report_runs_startedAt_idx" ON "report_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_runs_scheduleId_scheduledFor_key" ON "report_runs"("scheduleId", "scheduledFor");

-- CreateIndex
CREATE INDEX "report_deliveries_runId_idx" ON "report_deliveries"("runId");

-- CreateIndex
CREATE INDEX "report_deliveries_outboxId_idx" ON "report_deliveries"("outboxId");

-- CreateIndex
CREATE INDEX "report_artifacts_deliveryId_idx" ON "report_artifacts"("deliveryId");

-- CreateIndex
CREATE INDEX "report_artifacts_createdAt_idx" ON "report_artifacts"("createdAt");

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "report_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_runId_fkey" FOREIGN KEY ("runId") REFERENCES "report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "report_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

