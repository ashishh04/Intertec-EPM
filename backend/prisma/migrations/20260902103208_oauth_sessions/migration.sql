-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "refreshToken" TEXT,
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "auth_requests" (
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_requests_pkey" PRIMARY KEY ("state")
);

-- CreateIndex
CREATE INDEX "auth_requests_expiresAt_idx" ON "auth_requests"("expiresAt");
