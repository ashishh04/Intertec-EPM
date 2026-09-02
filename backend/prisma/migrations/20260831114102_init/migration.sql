-- CreateTable
CREATE TABLE "user_profiles" (
    "openProjectId" TEXT NOT NULL,
    "department" TEXT,
    "hoursCapacity" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("openProjectId")
);

-- CreateTable
CREATE TABLE "project_profiles" (
    "openProjectId" TEXT NOT NULL,
    "portfolio" TEXT,
    "budgetTotal" DOUBLE PRECISION,
    "budgetUsed" DOUBLE PRECISION,
    "healthOverride" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_profiles_pkey" PRIMARY KEY ("openProjectId")
);

-- CreateTable
CREATE TABLE "team_profiles" (
    "openProjectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_profiles_pkey" PRIMARY KEY ("openProjectId")
);

-- CreateTable
CREATE TABLE "sprint_profiles" (
    "openProjectId" TEXT NOT NULL,
    "goal" TEXT,
    "committedPoints" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sprint_profiles_pkey" PRIMARY KEY ("openProjectId")
);

-- CreateTable
CREATE TABLE "burndown_samples" (
    "id" TEXT NOT NULL,
    "sprintId" TEXT NOT NULL,
    "sampledOn" DATE NOT NULL,
    "remainingPoints" DOUBLE PRECISION NOT NULL,
    "completedPoints" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "burndown_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "scopeUserId" TEXT,
    "sampledOn" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_meta" (
    "openProjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_meta_pkey" PRIMARY KEY ("openProjectId")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "recordCount" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_profiles_slug_key" ON "team_profiles"("slug");

-- CreateIndex
CREATE INDEX "burndown_samples_sprintId_idx" ON "burndown_samples"("sprintId");

-- CreateIndex
CREATE UNIQUE INDEX "burndown_samples_sprintId_sampledOn_key" ON "burndown_samples"("sprintId", "sampledOn");

-- CreateIndex
CREATE INDEX "metric_snapshots_metric_sampledOn_idx" ON "metric_snapshots"("metric", "sampledOn");

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_scopeUserId_sampledOn_metric_key" ON "metric_snapshots"("scopeUserId", "sampledOn", "metric");

-- CreateIndex
CREATE INDEX "document_meta_projectId_idx" ON "document_meta"("projectId");

-- CreateIndex
CREATE INDEX "sync_runs_resource_startedAt_idx" ON "sync_runs"("resource", "startedAt");

-- CreateIndex
CREATE INDEX "sessions_openProjectId_idx" ON "sessions"("openProjectId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
