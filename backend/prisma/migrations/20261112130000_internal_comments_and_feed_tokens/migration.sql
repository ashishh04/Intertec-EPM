-- Internal comments and feed tokens: comments on a task for the organisation's
-- own people only, and the secret in a person's Atom feed addresses. Only adds.

-- CreateTable
CREATE TABLE "internal_comments" (
    "id" TEXT NOT NULL,
    "workPackageId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "feed_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "internal_comments_workPackageId_createdAt_idx" ON "internal_comments"("workPackageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "feed_tokens_userId_key" ON "feed_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "feed_tokens_tokenHash_key" ON "feed_tokens"("tokenHash");
