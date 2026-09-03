-- Employee mapping: where a person sits in EPM's org structure.
--
-- Additive only. user_profiles gains two nullable references and their indexes;
-- no existing column is altered or removed.
--
-- The legacy free-text `department` column is deliberately KEPT. This database
-- holds zero user_profiles rows and the column has no writer anywhere in the
-- codebase, so there is nothing to migrate here -- but another deployment could
-- hold values, and dropping the column would destroy them. Reads prefer the new
-- mapping and fall back to the free text until a person is mapped.
--
-- Both foreign keys are RESTRICT, matching teams -> departments: silently
-- orphaning a mapping is worse than refusing a delete.

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN "departmentId" TEXT,
ADD COLUMN "teamId" TEXT;

-- CreateIndex
CREATE INDEX "user_profiles_departmentId_idx" ON "user_profiles"("departmentId");

-- CreateIndex
CREATE INDEX "user_profiles_teamId_idx" ON "user_profiles"("teamId");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
