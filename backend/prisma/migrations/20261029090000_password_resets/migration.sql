-- A link for someone who has forgotten their password (Module 1).
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "replacedAt" TIMESTAMP(3),
    "requestedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

CREATE INDEX "password_reset_tokens_openProjectId_createdAt_idx" ON "password_reset_tokens"("openProjectId", "createdAt");
