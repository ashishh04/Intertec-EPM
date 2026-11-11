-- Programs: related projects run together, between a portfolio and its projects.
-- A project belongs to at most one, through its profile. Only adds.
-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN     "programId" TEXT;

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "portfolioId" TEXT,
    "managerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programs_code_key" ON "programs"("code");

-- CreateIndex
CREATE INDEX "programs_portfolioId_idx" ON "programs"("portfolioId");

-- CreateIndex
CREATE INDEX "programs_active_idx" ON "programs"("active");

-- CreateIndex
CREATE INDEX "project_profiles_programId_idx" ON "project_profiles"("programId");

-- AddForeignKey
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
