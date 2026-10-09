-- Who claimed an outbox row, and when (NFR03). Rows are claimed with
-- FOR UPDATE SKIP LOCKED, so two servers never take the same one, and a claim
-- that stalls is put back by its own age rather than by when the email was due
-- (a backlog row being sent by one server could otherwise be put back by
-- another mid-send).
ALTER TABLE "email_outbox" ADD COLUMN "claimedAt" TIMESTAMP(3), ADD COLUMN "claimedBy" TEXT;
