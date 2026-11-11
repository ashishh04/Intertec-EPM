-- Teams & clients: a team is the organisation's own, or an external client's.
-- Every team there is today is an internal one.
ALTER TABLE "teams" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "teams" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "teams" ADD COLUMN "contactPhone" TEXT;

-- The risk register: what EPM records about a risk beyond the work package
-- that is the risk (how likely, how bad, and the plan for it).
CREATE TABLE "risk_assessments" (
    "workPackageId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "probability" INTEGER,
    "impact" INTEGER,
    "category" TEXT,
    "response" TEXT,
    "mitigation" TEXT,
    "contingency" TEXT,
    "reviewOn" DATE,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("workPackageId")
);

CREATE INDEX "risk_assessments_projectId_idx" ON "risk_assessments"("projectId");
