-- Approvals (BRQ-09: BR-211 to BR-215) and escalation events.
--
-- Chains define who approves what; requests and tasks are one subject going
-- through one chain; delegations hand a person's approvals to someone else for
-- a period; link tokens back the decide-from-email links; escalation events are
-- raised when a step outlives its SLA, for the escalation engine to act on.

-- CreateTable
CREATE TABLE "approval_chains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subjectType" TEXT NOT NULL DEFAULT 'work_package',
    "typeIds" TEXT[],
    "projectIds" TEXT[],
    "valueField" TEXT,
    "steps" JSONB NOT NULL,
    "onSubmitStatusId" TEXT,
    "onApproveStatusId" TEXT,
    "onRejectStatusId" TEXT,
    "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "chainSnapshot" JSONB NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "statusBefore" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "outcomeAppliedAt" TIMESTAMP(3),
    "outcomeError" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_tasks" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepName" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "delegateId" TEXT,
    "delegationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "activatedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "breachedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "onBehalfOf" TEXT,
    "comment" TEXT,

    CONSTRAINT "approval_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" TEXT NOT NULL,
    "delegatorId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_link_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "projectId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "raisedFor" TEXT[],
    "reason" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "escalation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_chains_subjectType_active_idx" ON "approval_chains"("subjectType", "active");

-- CreateIndex
CREATE INDEX "approval_requests_subjectType_subjectId_idx" ON "approval_requests"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "approval_requests_projectId_status_idx" ON "approval_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_requestedBy_status_idx" ON "approval_requests"("requestedBy", "status");

-- CreateIndex
CREATE INDEX "approval_tasks_requestId_stepIndex_idx" ON "approval_tasks"("requestId", "stepIndex");

-- CreateIndex
CREATE INDEX "approval_tasks_approverId_status_idx" ON "approval_tasks"("approverId", "status");

-- CreateIndex
CREATE INDEX "approval_tasks_delegateId_status_idx" ON "approval_tasks"("delegateId", "status");

-- CreateIndex
CREATE INDEX "approval_tasks_status_dueAt_idx" ON "approval_tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "approval_delegations_delegatorId_startsOn_endsOn_idx" ON "approval_delegations"("delegatorId", "startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "approval_delegations_delegateId_idx" ON "approval_delegations"("delegateId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_link_tokens_tokenHash_key" ON "approval_link_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "approval_link_tokens_taskId_idx" ON "approval_link_tokens"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_events_dedupeKey_key" ON "escalation_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "escalation_events_source_raisedAt_idx" ON "escalation_events"("source", "raisedAt");

-- CreateIndex
CREATE INDEX "escalation_events_projectId_raisedAt_idx" ON "escalation_events"("projectId", "raisedAt");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "approval_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

