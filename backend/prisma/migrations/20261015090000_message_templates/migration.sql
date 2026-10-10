-- Translatable templates beside the English text EPM stores (BR-605). The
-- English stays the record — what an operator searches and what older rows
-- hold — and the template lets each reader see the sentence in their own
-- language. Nullable: rows written before this have none, and show their
-- English.
ALTER TABLE "audit_events" ADD COLUMN "summaryMessage" JSONB;
ALTER TABLE "project_health_states" ADD COLUMN "explanationMessage" JSONB;
ALTER TABLE "escalation_events" ADD COLUMN "reasonMessage" JSONB;
