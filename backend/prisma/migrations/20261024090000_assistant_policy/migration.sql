-- Administrators' guardrails for Pragnya, the assistant.
CREATE TABLE "assistant_policy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowFinance" BOOLEAN NOT NULL DEFAULT true,
    "allowPeople" BOOLEAN NOT NULL DEFAULT true,
    "dailyLimit" INTEGER NOT NULL DEFAULT 100,
    "blockedTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guidance" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_policy_pkey" PRIMARY KEY ("id")
);
