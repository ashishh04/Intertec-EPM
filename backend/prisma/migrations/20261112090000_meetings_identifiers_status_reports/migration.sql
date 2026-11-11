-- Repeating meetings and agenda items (each item may be about a task), project
-- identifiers kept back by an administrator, and status reports on projects and
-- portfolios. Only adds: nothing existing changes.
-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "seriesId" TEXT;

-- CreateTable
CREATE TABLE "meeting_series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "projectId" TEXT,
    "location" TEXT,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "agenda" TEXT,
    "participantIds" TEXT[],
    "frequency" TEXT NOT NULL,
    "firstStartsAt" TIMESTAMP(3) NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "until" DATE,
    "generatedThrough" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_agenda_items" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "durationMinutes" INTEGER,
    "workPackageId" INTEGER,
    "presenterId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_agenda_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserved_identifiers" (
    "identifier" TEXT NOT NULL,
    "note" TEXT,
    "reservedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserved_identifiers_pkey" PRIMARY KEY ("identifier")
);

-- CreateTable
CREATE TABLE "status_reports" (
    "id" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "overall" TEXT NOT NULL,
    "schedule" TEXT,
    "budget" TEXT,
    "scope" TEXT,
    "resources" TEXT,
    "summary" TEXT NOT NULL,
    "achievements" TEXT,
    "nextSteps" TEXT,
    "issues" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_series_projectId_idx" ON "meeting_series"("projectId");

-- CreateIndex
CREATE INDEX "meeting_agenda_items_meetingId_position_idx" ON "meeting_agenda_items"("meetingId", "position");

-- CreateIndex
CREATE INDEX "meeting_agenda_items_workPackageId_idx" ON "meeting_agenda_items"("workPackageId");

-- CreateIndex
CREATE INDEX "status_reports_scopeKind_scopeId_reportDate_idx" ON "status_reports"("scopeKind", "scopeId", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_seriesId_startsAt_key" ON "meetings"("seriesId", "startsAt");

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "meeting_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
