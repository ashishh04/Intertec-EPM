-- CSV imports of tasks into a project.
CREATE TABLE "task_imports" (
    "id" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "linked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "problems" JSONB NOT NULL,
    "results" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_imports_projectId_createdAt_idx" ON "task_imports"("projectId", "createdAt");
