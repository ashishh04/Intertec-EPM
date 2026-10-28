-- Drop the links from invitation and password-reset emails already sent or
-- given up on: each carries the only copy of a token that opens an account.
-- From now on the outbox drops them itself as the email goes (email/outbox.ts).
UPDATE "email_outbox" SET "payload" = "payload" - 'inviteUrl' - 'resetUrl'
 WHERE "template" IN ('invite', 'password-reset') AND "status" IN ('sent', 'failed');
