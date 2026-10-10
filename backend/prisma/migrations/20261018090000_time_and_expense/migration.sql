-- Time and expense (Module 10: BR-304 to BR-309, BR-317).
--
-- Timesheets: one person's time for a period, submitted for approval, which
-- locks it. Expense claims with their receipts, which become OpenProject cost
-- entries once approved. Versioned settings for the timesheet bounds, the time
-- logging policies and the receipt threshold. And whether a project's owner
-- approves the time logged on it.
--
-- Two approval chains to start from, editable under Approval chains: a
-- timesheet goes to the person's line manager, then to the owners of the
-- projects its time is on (a step skipped when no project has one); a claim
-- goes to the line manager, and above 1,000 also to the project's owner.

-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN     "timesheetApproval" BOOLEAN;

-- CreateTable
CREATE TABLE "time_setting_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_setting_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheets" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hours" DOUBLE PRECISION,
    "entries" INTEGER,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "requestId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" TEXT NOT NULL,
    "claimantId" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "costTypeId" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "costEntryId" INTEGER,
    "postedAt" TIMESTAMP(3),
    "postError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_receipts" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "time_setting_sets_version_key" ON "time_setting_sets"("version");

-- CreateIndex
CREATE INDEX "timesheets_periodStart_status_idx" ON "timesheets"("periodStart", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheets_personId_periodStart_key" ON "timesheets"("personId", "periodStart");

-- CreateIndex
CREATE INDEX "expense_claims_claimantId_status_idx" ON "expense_claims"("claimantId", "status");

-- CreateIndex
CREATE INDEX "expense_claims_projectId_status_idx" ON "expense_claims"("projectId", "status");

-- CreateIndex
CREATE INDEX "expense_claims_status_spentOn_idx" ON "expense_claims"("status", "spentOn");

-- CreateIndex
CREATE INDEX "expense_receipts_claimId_idx" ON "expense_receipts"("claimId");

-- AddForeignKey
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "expense_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Default chains
INSERT INTO "approval_chains" ("id", "name", "description", "subjectType", "typeIds", "projectIds", "valueField", "steps", "allowSelfApproval", "active", "createdBy", "createdAt", "updatedAt")
VALUES
  ('chain-timesheets-default', 'Timesheets',
   'The line manager, then the owners of the projects the time is on.',
   'timesheet', '{}', '{}', NULL,
   '[{"id":"line","name":"Line manager","approvers":[{"kind":"requester_manager"}],"mode":"any"},{"id":"projects","name":"Project owners","approvers":[{"kind":"project_owner"}],"mode":"all","skipIfNobody":true}]'::jsonb,
   false, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('chain-expenses-default', 'Expense claims',
   'The line manager; above 1,000, the project''s owner as well.',
   'expense_claim', '{}', '{}', NULL,
   '[{"id":"line","name":"Line manager","approvers":[{"kind":"requester_manager"}],"mode":"any"},{"id":"additional","name":"Additional approval","approvers":[{"kind":"project_owner"}],"mode":"any","condition":{"field":"value","operator":"gt","value":1000}}]'::jsonb,
   false, true, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
