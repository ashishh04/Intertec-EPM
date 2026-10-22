-- Inbound integration events (BR-506): every delivery kept once, keyed on its
-- identity, processed idempotently, retried, dead-lettered when retries run
-- out, and replayable by an operator.
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "replayedBy" TEXT,
    "replayedAt" TIMESTAMP(3),
    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "integration_events_source_eventKey_key" ON "integration_events"("source", "eventKey");
CREATE INDEX "integration_events_status_nextAttemptAt_idx" ON "integration_events"("status", "nextAttemptAt");
CREATE INDEX "integration_events_receivedAt_idx" ON "integration_events"("receivedAt");
