-- Two-factor authentication: authenticators, recovery codes, sign-ins waiting on
-- a code, and which roles must use it. Nothing here changes anyone's sign-in until
-- they set it up or an administrator requires it.
CREATE TABLE "user_mfa" (
    "openProjectId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("openProjectId")
);

CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mfa_challenges" (
    "id" TEXT NOT NULL,
    "openProjectId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mfa_policy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "requiredRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_policy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_codes_openProjectId_codeHash_key" ON "mfa_recovery_codes"("openProjectId", "codeHash");

CREATE INDEX "mfa_challenges_openProjectId_idx" ON "mfa_challenges"("openProjectId");

CREATE INDEX "mfa_challenges_expiresAt_idx" ON "mfa_challenges"("expiresAt");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_openProjectId_fkey" FOREIGN KEY ("openProjectId") REFERENCES "user_mfa"("openProjectId") ON DELETE CASCADE ON UPDATE CASCADE;
