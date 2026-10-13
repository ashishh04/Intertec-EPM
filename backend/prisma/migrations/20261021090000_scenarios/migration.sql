-- Portfolio scenarios (BR-220 to BR-222).
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "portfolioId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "requestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decision" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scenario_projects" (
    "scenarioId" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "shiftMonths" INTEGER NOT NULL DEFAULT 0,
    "shiftDays" INTEGER NOT NULL DEFAULT 0,
    "budget" DOUBLE PRECISION,
    "capturedStart" DATE,
    "capturedFinish" DATE,
    "capturedBudget" DOUBLE PRECISION,
    CONSTRAINT "scenario_projects_pkey" PRIMARY KEY ("scenarioId","projectId")
);

CREATE TABLE "scenario_work" (
    "scenarioId" TEXT NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "remainingHours" DOUBLE PRECISION NOT NULL,
    "startDate" DATE,
    "dueDate" DATE,
    "isMilestone" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "scenario_work_pkey" PRIMARY KEY ("scenarioId","workPackageId")
);

CREATE INDEX "scenario_work_scenarioId_projectId_idx" ON "scenario_work"("scenarioId", "projectId");
ALTER TABLE "scenario_projects" ADD CONSTRAINT "scenario_projects_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scenario_work" ADD CONSTRAINT "scenario_work_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Promotion is approved by the owners of the projects the scenario changes.
INSERT INTO "approval_chains" ("id", "name", "description", "subjectType", "typeIds", "projectIds", "valueField", "steps", "allowSelfApproval", "active", "createdBy", "createdAt", "updatedAt")
VALUES
  ('chain-scenarios-default', 'Scenarios',
   'Every owner of a project the scenario changes.',
   'scenario', '{}', '{}', NULL,
   '[{"id":"owners","name":"Project owners","approvers":[{"kind":"project_owner"}],"mode":"all"}]'::jsonb,
   false, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
