-- Project requests and stage gate reviews: a request to start a project, and a
-- review of a gate in a project's life cycle, each decided through an approval
-- chain. Only adds.

-- CreateTable
CREATE TABLE "project_requests" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "identifier" TEXT,
    "description" TEXT,
    "businessCase" TEXT,
    "sponsorId" TEXT,
    "portfolioId" TEXT,
    "programId" TEXT,
    "templateId" TEXT,
    "budget" DOUBLE PRECISION,
    "startDate" DATE,
    "finishDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_gate_reviews" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "gateName" TEXT NOT NULL,
    "phaseName" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "requestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_gate_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_requests_status_idx" ON "project_requests"("status");

-- CreateIndex
CREATE INDEX "project_requests_requestedBy_idx" ON "project_requests"("requestedBy");

-- CreateIndex
CREATE INDEX "stage_gate_reviews_projectId_definitionId_gate_idx" ON "stage_gate_reviews"("projectId", "definitionId", "gate");
