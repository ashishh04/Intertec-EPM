-- Rules and escalation (BRQ-10: BR-216 to BR-219), and job leases (NFR03, NFR04).
--
-- Automation rules watch work package and project events and act as EPM's
-- automation account; rule events are the queue those events wait in, claimed
-- per row so two servers never consider the same one twice; rule item states
-- remember whether an item matched a rule, so a rule fires as an item starts
-- to match; rule firings are the log of every firing and what each action did.
-- Escalation policies raise an item through levels when it is untouched,
-- overdue or past an approval's SLA, recorded as escalation events. Job leases
-- let one server at a time run a scheduled job.

-- AlterTable
ALTER TABLE "escalation_events" ADD COLUMN     "episode" TEXT,
ADD COLUMN     "policyId" TEXT;

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "subjectType" TEXT NOT NULL DEFAULT 'work_package',
    "events" TEXT[],
    "projectIds" TEXT[],
    "conditions" JSONB NOT NULL,
    "fireMode" TEXT NOT NULL DEFAULT 'enter',
    "actions" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "projectId" TEXT,
    "version" INTEGER,
    "actorId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "rule_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_item_states" (
    "ruleId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_item_states_pkey" PRIMARY KEY ("ruleId","subjectType","subjectId")
);

-- CreateTable
CREATE TABLE "rule_firings" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "ruleName" TEXT NOT NULL,
    "eventId" TEXT,
    "trigger" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectTitle" TEXT,
    "projectId" TEXT,
    "outcome" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,

    CONSTRAINT "rule_firings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "projectIds" TEXT[],
    "typeIds" TEXT[],
    "priorityIds" TEXT[],
    "levels" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "automation_rules_active_subjectType_idx" ON "automation_rules"("active", "subjectType");

-- CreateIndex
CREATE UNIQUE INDEX "rule_events_dedupeKey_key" ON "rule_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "rule_events_processedAt_receivedAt_idx" ON "rule_events"("processedAt", "receivedAt");

-- CreateIndex
CREATE INDEX "rule_firings_ruleId_firedAt_idx" ON "rule_firings"("ruleId", "firedAt");

-- CreateIndex
CREATE INDEX "rule_firings_projectId_firedAt_idx" ON "rule_firings"("projectId", "firedAt");

-- CreateIndex
CREATE INDEX "rule_firings_subjectType_subjectId_idx" ON "rule_firings"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "escalation_policies_active_trigger_idx" ON "escalation_policies"("active", "trigger");

-- CreateIndex
CREATE INDEX "escalation_events_policyId_resolvedAt_idx" ON "escalation_events"("policyId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "rule_firings" ADD CONSTRAINT "rule_firings_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

