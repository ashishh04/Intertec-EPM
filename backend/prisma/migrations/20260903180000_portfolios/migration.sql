-- Portfolios: a named grouping of projects, EPM-owned.
--
-- Additive only. project_profiles gains a nullable reference and its index; the
-- legacy free-text `portfolio` column is deliberately KEPT. It is empty in this
-- database, but PATCH /projects/:id has always accepted an arbitrary string for
-- it, so another deployment could hold values that dropping the column would
-- destroy. Reads prefer the reference and fall back to the text.
--
-- The foreign key is RESTRICT, matching teams -> departments and user_profiles:
-- silently orphaning an association is worse than refusing a delete.

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_code_key" ON "portfolios"("code");

-- CreateIndex
CREATE INDEX "portfolios_active_idx" ON "portfolios"("active");

-- Case-insensitive name uniqueness, as for departments and teams. Raw SQL
-- because Prisma cannot express an index on an expression; the model therefore
-- carries no @unique on name, so no redundant plain index is created alongside.
CREATE UNIQUE INDEX "portfolios_name_lower_key" ON "portfolios" (LOWER("name"));

-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN "portfolioId" TEXT;

-- CreateIndex
CREATE INDEX "project_profiles_portfolioId_idx" ON "project_profiles"("portfolioId");

-- AddForeignKey
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_portfolioId_fkey"
    FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
