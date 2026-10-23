-- Delivery forecasts (BR-509, BR-510) and recommended actions (BR-511, BR-512).
CREATE TABLE "forecast_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "modelVersion" TEXT,
    "model" JSONB,
    "summary" JSONB,
    "error" TEXT,
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "forecast_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "forecast_runs_kind_startedAt_idx" ON "forecast_runs"("kind", "startedAt");

CREATE TABLE "project_forecasts" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "inputs" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_forecasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_forecasts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "forecast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_forecasts_projectId_createdAt_idx" ON "project_forecasts"("projectId", "createdAt");
CREATE INDEX "project_forecasts_runId_idx" ON "project_forecasts"("runId");

CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "forecastId" TEXT,
    "projectId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "expectedEffect" JSONB NOT NULL,
    "change" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "recommendations_projectId_status_idx" ON "recommendations"("projectId", "status");
CREATE INDEX "recommendations_targetKey_status_idx" ON "recommendations"("targetKey", "status");
